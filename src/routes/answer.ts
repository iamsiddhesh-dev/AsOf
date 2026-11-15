import { Hono, type Context } from "hono";
import { answerQuestion, type AnswerResult } from "../answer/answer.js";
import { extractClaims, type ClaimExtractionResult } from "../claims/extract.js";
import { config } from "../config.js";
import {
  appendTurn,
  getConversation,
  getTurn,
  setTurnClaimsStatus,
} from "../conversations/repository.js";
import type { Db } from "../db/index.js";
import { countClaims } from "../ledger/claims.js";
import {
  ProviderError,
  type ChatClient,
  type SearchClient,
} from "../providers/types.js";
import { classify } from "../router/classify.js";
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
    const conversation = getConversation(db, c.req.param("id"));
    if (conversation === null) {
      return c.json({ error: "conversation not found" }, 404);
    }

    const body = await readJson(c);
    if (body === null) {
      return c.json({ error: "body must be a json object" }, 400);
    }

    const text = nonEmptyString(body["text"]);
    if (text === null) {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    if (text.length > 2_000) {
      return c.json({ error: "text is too long" }, 400);
    }

    const keywordValue = body["keyword"];
    if (
      keywordValue !== undefined &&
      keywordValue !== null &&
      typeof keywordValue !== "string"
    ) {
      return c.json({ error: "keyword must be a string" }, 400);
    }
    const keyword = nonEmptyString(keywordValue);
    if (keyword !== null && keyword.length > 100) {
      return c.json({ error: "keyword is too long" }, 400);
    }

    const timezone = requestTimezone(c, conversation.timezone);
    if (timezone === null) {
      return c.json({ error: "invalid timezone" }, 400);
    }

    const missing: string[] = [];
    if (chat === null) {
      missing.push("LLM_API_KEY");
    }
    if (search === null) {
      missing.push("TAVILY_API_KEY");
    }
    if (chat === null || search === null) {
      return c.json(
        {
          error: "providers are not configured",
          missing,
          hint: "run npm run doctor",
        },
        503,
      );
    }

    const now = clock();
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

    const userTurnInput = {
      conversationId: conversation.id,
      role: "user" as const,
      content: text,
      createdAt: now.toISOString(),
      resolvedStart: decision.timeRange?.start ?? null,
      resolvedEnd: decision.timeRange?.end ?? null,
      resolvedLabel: decision.timeRange?.label ?? null,
      intent: decision.intent,
    };

    // Answer before writing: "nothing has been stored yet" must describe the
    // ledger as it was before this question, not after it.
    let result: AnswerResult;
    try {
      result = await answerQuestion(db, { search, chat, model }, {
        text,
        timezone,
        now,
        decision,
        keyword,
      });
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      const userTurn = appendTurn(db, userTurnInput);
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

    const userTurn = appendTurn(db, userTurnInput);

    const assistantTurn = appendTurn(db, {
      conversationId: conversation.id,
      role: "assistant",
      content: result.answer,
      createdAt: clock().toISOString(),
      parentTurnId: userTurn.id,
      intent: decision.intent,
      model: result.model,
      latencyMs: result.latencyMs,
      tokenIn: result.tokenIn,
      tokenOut: result.tokenOut,
    });

    /**
     * Only a grounded answer has evidence worth extracting from. A failed
     * extraction is recorded on the turn, not raised: the answer the user
     * already has is still valid, it simply has no claims to recheck yet.
     */
    let claims: ClaimExtractionResult;
    if (result.grounded === true && result.citations.length > 0) {
      if (extractChat === null) {
        setTurnClaimsStatus(db, assistantTurn.id, "failed");
        claims = {
          inserted: 0,
          superseded: 0,
          dropped: 0,
          reason: "extraction provider is not configured",
        };
      } else {
        try {
          claims = await extractClaims(
            db,
            { chat: extractChat, model: extractModel },
            {
              answer: result.answer,
              sources: result.citations,
              turnId: assistantTurn.id,
              conversationId: conversation.id,
              now: clock(),
              provider: search.name,
            },
          );
          setTurnClaimsStatus(db, assistantTurn.id, "done");
        } catch (error) {
          setTurnClaimsStatus(db, assistantTurn.id, "failed");
          claims = {
            inserted: 0,
            superseded: 0,
            dropped: 0,
            reason: (error as Error).message,
          };
        }
      }
    } else {
      setTurnClaimsStatus(db, assistantTurn.id, "skipped");
      claims = {
        inserted: 0,
        superseded: 0,
        dropped: 0,
        reason: "answer was not grounded",
      };
    }

    return c.json({
      ...result,
      claims,
      decision,
      userTurnId: userTurn.id,
      assistantTurnId: assistantTurn.id,
    });
  });

  return router;
}
