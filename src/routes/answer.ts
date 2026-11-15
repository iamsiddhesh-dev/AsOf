import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { answerQuestion, type AnswerResult } from "../answer/answer.js";
import {
  appendQuestion,
  persistAnswer,
  type PersistedAnswer,
} from "../answer/persist.js";
import { config } from "../config.js";
import {
  getConversation,
  getTurn,
  type Conversation,
} from "../conversations/repository.js";
import type { Db } from "../db/index.js";
import { countClaims } from "../ledger/claims.js";
import {
  ProviderError,
  type ChatClient,
  type SearchClient,
} from "../providers/types.js";
import { classify, type RouteDecision } from "../router/classify.js";
import { requestTimezone } from "./timezone.js";

type JsonObject = Record<string, unknown>;

export type AnswerRouteOptions = {
  clock?: () => Date;
  search?: SearchClient | null;
  chat?: ChatClient | null;
  /** Defaults to `chat`; production passes the fast provider's client. */
  extractChat?: ChatClient | null;
  model?: string;
  /** Claims are extraction, not synthesis, so they use the fast model. */
  extractModel?: string;
};

async function readJson(c: Context): Promise<JsonObject | null> {
  try {
    const value = await c.req.json();
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as JsonObject)
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

type Prepared = {
  ok: true;
  conversation: Conversation;
  text: string;
  keyword: string | null;
  timezone: string;
  now: Date;
  decision: RouteDecision;
  search: SearchClient;
  chat: ChatClient;
};

type Rejected = { ok: false; response: Response };

/**
 * Everything both endpoints need before the plan runs: a valid body, a
 * timezone, configured providers, and a routing decision. Kept in one place so
 * a streamed answer cannot be validated differently from a JSON one.
 */
async function prepare(
  c: Context,
  db: Db,
  options: {
    clock: () => Date;
    search: SearchClient | null;
    chat: ChatClient | null;
  },
): Promise<Prepared | Rejected> {
  const conversation = getConversation(db, c.req.param("id") ?? "");
  if (conversation === null) {
    return { ok: false, response: c.json({ error: "conversation not found" }, 404) };
  }

  const body = await readJson(c);
  if (body === null) {
    return {
      ok: false,
      response: c.json({ error: "body must be a json object" }, 400),
    };
  }

  const text = nonEmptyString(body["text"]);
  if (text === null) {
    return {
      ok: false,
      response: c.json({ error: "text must be a non-empty string" }, 400),
    };
  }
  if (text.length > 2_000) {
    return { ok: false, response: c.json({ error: "text is too long" }, 400) };
  }

  const keywordValue = body["keyword"];
  if (
    keywordValue !== undefined &&
    keywordValue !== null &&
    typeof keywordValue !== "string"
  ) {
    return {
      ok: false,
      response: c.json({ error: "keyword must be a string" }, 400),
    };
  }
  const keyword = nonEmptyString(keywordValue);
  if (keyword !== null && keyword.length > 100) {
    return { ok: false, response: c.json({ error: "keyword is too long" }, 400) };
  }

  const timezone = requestTimezone(c, conversation.timezone);
  if (timezone === null) {
    return { ok: false, response: c.json({ error: "invalid timezone" }, 400) };
  }

  const missing: string[] = [];
  if (options.chat === null) {
    missing.push("LLM_API_KEY");
  }
  if (options.search === null) {
    missing.push("TAVILY_API_KEY");
  }
  if (options.chat === null || options.search === null) {
    return {
      ok: false,
      response: c.json(
        {
          error: "providers are not configured",
          missing,
          hint: "run npm run doctor",
        },
        503,
      ),
    };
  }

  const now = options.clock();
  const lastAnswerAt =
    conversation.state.lastAnswerTurnId === null
      ? null
      : getTurn(db, conversation.state.lastAnswerTurnId)?.createdAt ?? null;

  const decision = classify({
    text,
    now,
    timezone,
    state: conversation.state,
    lastAnswerAt,
    priorClaimCount: countClaims(db),
  });

  return {
    ok: true,
    conversation,
    text,
    keyword,
    timezone,
    now,
    decision,
    search: options.search,
    chat: options.chat,
  };
}

function retryableStatus(status: number | null): boolean {
  return status !== null && (status === 408 || status === 429 || status >= 500);
}

/** Thrown when the SSE socket has gone away, so the work can stop early. */
class StreamClosed extends Error {
  constructor() {
    super("client disconnected");
    this.name = "StreamClosed";
  }
}

/**
 * Ask writes the question, runs the plan, and writes the answer. The ledger is
 * the product, so an answer that only exists in a response body has not
 * happened yet as far as memory is concerned.
 */
export function answerRoutes(db: Db, options: AnswerRouteOptions = {}) {
  const router = new Hono();
  const clock = options.clock ?? (() => new Date());
  const search = options.search ?? null;
  const chat = options.chat ?? null;
  const extractChat = options.extractChat ?? chat;
  const model = options.model ?? config.model.main.model;
  const extractModel = options.extractModel ?? config.model.fast.model;

  router.post("/:id/ask", async (c) => {
    const prepared = await prepare(c, db, { clock, search, chat });
    if (!prepared.ok) {
      return prepared.response;
    }

    const { conversation, text, keyword, timezone, now, decision } = prepared;

    // Answer before writing: "nothing has been stored yet" must describe the
    // ledger as it was before this question, not after it.
    let result: AnswerResult;
    try {
      result = await answerQuestion(
        db,
        { search: prepared.search, chat: prepared.chat, model, extractChat, extractModel },
        {
          text,
          timezone,
          now,
          decision,
          state: conversation.state,
          keyword,
        },
      );
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      const userTurn = appendQuestion(db, {
        conversationId: conversation.id,
        text,
        decision,
        now,
      });
      return c.json(
        {
          error: (error as Error).message,
          provider: providerError?.provider ?? null,
          decision,
          userTurnId: userTurn.id,
        },
        providerError === null ? 500 : 502,
      );
    }

    const persisted: PersistedAnswer = await persistAnswer(
      db,
      result,
      { conversationId: conversation.id, text, decision, now },
      {
        clock,
        searchProvider: prepared.search.name,
        extractChat,
        extractModel,
      },
    );

    const { claimUpdates: _claimUpdates, ...publicResult } = result;
    void _claimUpdates;

    return c.json({
      ...publicResult,
      claims: persisted.claims,
      claimsStatus: persisted.claimsStatus,
      decision,
      userTurnId: persisted.userTurn.id,
      assistantTurnId: persisted.assistantTurn.id,
    });
  });

  /**
   * The same plan, reported as it runs. Recall and recheck arrive as whole
   * `block` events because they are reads, not generation; only model
   * synthesis streams, as `delta` events keyed by the part they belong to.
   * Concatenating the blocks and deltas in order, separated by a blank line,
   * reproduces `done.answer`.
   */
  router.post("/:id/ask/stream", async (c) => {
    const prepared = await prepare(c, db, { clock, search, chat });
    if (!prepared.ok) {
      return prepared.response;
    }

    const { conversation, text, keyword, timezone, now, decision } = prepared;
    const persistInput = {
      conversationId: conversation.id,
      text,
      decision,
      now,
    };

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      const send = async (event: string, data: unknown): Promise<void> => {
        if (closed) {
          throw new StreamClosed();
        }
        await stream.writeSSE({ event, data: JSON.stringify(data) });
      };

      try {
        await send("decision", {
          intent: decision.intent,
          confidence: decision.confidence,
          timeRange: decision.timeRange,
          blockedBy: decision.blockedBy,
          steps: decision.steps,
        });

        const result = await answerQuestion(
          db,
          {
            search: prepared.search,
            chat: prepared.chat,
            model,
            extractChat,
            extractModel,
          },
          {
            text,
            timezone,
            now,
            decision,
            state: conversation.state,
            keyword,
            hooks: {
              onStepStart: (action) => send("step", { action, status: "running" }),
              onStep: (step) => send("step", step),
              onSources: (citations) => send("sources", { citations }),
              onBlock: (block) => send("block", block),
              onDelta: (index, delta) =>
                send("delta", { index, text: delta }),
            },
          },
        );

        // Turns are written on completion, not at the start of the stream.
        // A half-written assistant turn would be readable by recall and would
        // make `lastAnswerTurnId` point at an answer nobody finished.
        const persisted = await persistAnswer(db, result, persistInput, {
          clock,
          searchProvider: prepared.search.name,
          extractChat,
          extractModel,
        });

        const { claimUpdates: _claimUpdates, ...publicResult } = result;
        void _claimUpdates;

        await send("done", {
          ...publicResult,
          claims: persisted.claims,
          claimsStatus: persisted.claimsStatus,
          decision,
          userTurnId: persisted.userTurn.id,
          assistantTurnId: persisted.assistantTurn.id,
        });
      } catch (error) {
        if (closed || error instanceof StreamClosed) {
          return;
        }

        const providerError = error instanceof ProviderError ? error : null;

        // The question was asked, so it is recorded even though no answer was.
        let userTurnId: string | null = null;
        try {
          userTurnId = appendQuestion(db, persistInput).id;
        } catch {
          userTurnId = null;
        }

        try {
          await send("error", {
            message: (error as Error).message,
            provider: providerError?.provider ?? null,
            status: providerError?.status ?? null,
            retryable: retryableStatus(providerError?.status ?? null),
            userTurnId,
          });
        } catch {
          // The socket is gone; there is nowhere left to report to.
        }
      }
    });
  });

  return router;
}
