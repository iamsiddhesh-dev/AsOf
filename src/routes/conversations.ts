import { Hono, type Context } from "hono";
import { config } from "../config.js";
import {
  appendTurn,
  createConversation,
  getConversation,
  getTurn,
  listConversations,
  listTurns,
  recallTurns,
  type TurnRole,
} from "../conversations/repository.js";
import type { Db } from "../db/index.js";
import { isValidTimeZone, resolveDateRange } from "../time/resolve.js";

type JsonObject = Record<string, unknown>;

export type ConversationRouteOptions = {
  clock?: () => Date;
};

const TURN_ROLES: readonly TurnRole[] = [
  "system",
  "user",
  "assistant",
  "tool",
];

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

function parseLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : null;
}

export function conversationRoutes(
  db: Db,
  options: ConversationRouteOptions = {},
) {
  const router = new Hono();
  const clock = options.clock ?? (() => new Date());

  router.post("/", async (c) => {
    const body = await readJson(c);
    if (body === null) {
      return c.json({ error: "body must be a json object" }, 400);
    }

    const titleValue = body["title"];
    if (
      titleValue !== undefined &&
      (typeof titleValue !== "string" ||
        titleValue.trim().length === 0 ||
        titleValue.length > 200)
    ) {
      return c.json({ error: "title must be 1-200 characters" }, 400);
    }

    const timezoneValue = body["timezone"];
    if (
      timezoneValue !== undefined &&
      (typeof timezoneValue !== "string" || timezoneValue.trim().length === 0)
    ) {
      return c.json({ error: "timezone must be a non-empty string" }, 400);
    }

    const timezone =
      typeof timezoneValue === "string" ? timezoneValue : config.timezone;
    if (!isValidTimeZone(timezone)) {
      return c.json({ error: "invalid timezone" }, 400);
    }

    const conversation = createConversation(db, {
      title:
        typeof titleValue === "string"
          ? titleValue.trim()
          : "New conversation",
      timezone,
      now: clock(),
    });
    return c.json(conversation, 201);
  });

  router.get("/", (c) => {
    return c.json({ conversations: listConversations(db) });
  });

  router.get("/:id", (c) => {
    const conversation = getConversation(db, c.req.param("id"));
    if (conversation === null) {
      return c.json({ error: "conversation not found" }, 404);
    }
    return c.json(conversation);
  });

  router.post("/:id/turns", async (c) => {
    const conversation = getConversation(db, c.req.param("id"));
    if (conversation === null) {
      return c.json({ error: "conversation not found" }, 404);
    }

    const body = await readJson(c);
    if (body === null) {
      return c.json({ error: "body must be a json object" }, 400);
    }

    const role = body["role"];
    if (!TURN_ROLES.includes(role as TurnRole)) {
      return c.json({ error: "role must be system, user, assistant, or tool" }, 400);
    }

    const content = nonEmptyString(body["content"]);
    if (content === null) {
      return c.json({ error: "content must be a non-empty string" }, 400);
    }
    if (content.length > 100_000) {
      return c.json({ error: "content is too long" }, 400);
    }

    const parentValue = body["parentTurnId"];
    if (
      parentValue !== undefined &&
      parentValue !== null &&
      typeof parentValue !== "string"
    ) {
      return c.json({ error: "parentTurnId must be a string" }, 400);
    }
    const parentTurnId = parentValue ?? null;
    if (parentTurnId !== null) {
      const parent = getTurn(db, parentTurnId);
      if (parent === null || parent.conversationId !== conversation.id) {
        return c.json({ error: "parentTurnId does not belong to this conversation" }, 400);
      }
    }

    const now = clock();
    const lastAnswerAt =
      conversation.state.lastAnswerTurnId === null
        ? null
        : getTurn(db, conversation.state.lastAnswerTurnId)?.createdAt ?? null;

    const resolved =
      role === "user"
        ? resolveDateRange(content, {
            now,
            timezone: conversation.timezone,
            lastAnswerAt,
            direction: "past",
          })
        : null;

    const turn = appendTurn(db, {
      conversationId: conversation.id,
      role: role as TurnRole,
      content,
      createdAt: now.toISOString(),
      parentTurnId,
      resolvedStart: resolved?.start ?? null,
      resolvedEnd: resolved?.end ?? null,
      resolvedLabel: resolved?.label ?? null,
    });

    return c.json(turn, 201);
  });

  router.get("/:id/turns", (c) => {
    const conversation = getConversation(db, c.req.param("id"));
    if (conversation === null) {
      return c.json({ error: "conversation not found" }, 404);
    }

    const limit = parseLimit(c.req.query("limit"), 50);
    if (limit === null) {
      return c.json({ error: "limit must be an integer from 1 to 200" }, 400);
    }

    const date = c.req.query("date");
    if (date !== undefined) {
      const lastAnswerAt =
        conversation.state.lastAnswerTurnId === null
          ? null
          : getTurn(db, conversation.state.lastAnswerTurnId)?.createdAt ?? null;
      const range = resolveDateRange(date, {
        now: clock(),
        timezone: conversation.timezone,
        lastAnswerAt,
        direction: "past",
      });
      if (range === null) {
        return c.json({ error: "could not resolve date" }, 400);
      }
      return c.json({
        range,
        turns: recallTurns(db, conversation.id, range, limit),
      });
    }

    return c.json({ turns: listTurns(db, conversation.id, limit) });
  });

  return router;
}
