import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { memoryStats } from "../conversations/repository.js";
import type { Db } from "../db/index.js";
import { answerRecall } from "../memory/recall.js";
import { requestTimezone } from "./timezone.js";

type JsonObject = Record<string, unknown>;

export type MemoryRouteOptions = {
  clock?: () => Date;
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

export function memoryRoutes(db: Db, options: MemoryRouteOptions = {}) {
  const router = new Hono();
  const clock = options.clock ?? (() => new Date());

  router.get("/stats", (c) => {
    return c.json(memoryStats(db));
  });

  router.post("/recall", async (c) => {
    const body = await readJson(c);
    if (body === null) {
      return c.json({ error: "body must be a json object" }, 400);
    }

    const textValue = body["text"];
    if (typeof textValue !== "string" || textValue.trim().length === 0) {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    if (textValue.length > 2_000) {
      return c.json({ error: "text is too long" }, 400);
    }

    const timezone = requestTimezone(c, config.timezone);
    if (timezone === null) {
      return c.json({ error: "invalid timezone" }, 400);
    }

    const keywordValue = body["keyword"];
    if (
      keywordValue !== undefined &&
      keywordValue !== null &&
      typeof keywordValue !== "string"
    ) {
      return c.json({ error: "keyword must be a string" }, 400);
    }

    const limitValue = body["limit"];
    if (
      limitValue !== undefined &&
      (!Number.isInteger(limitValue) || (limitValue as number) < 1 || (limitValue as number) > 200)
    ) {
      return c.json({ error: "limit must be an integer from 1 to 200" }, 400);
    }

    return c.json(
      answerRecall(db, {
        text: textValue,
        now: clock(),
        timezone,
        keyword: typeof keywordValue === "string" ? keywordValue : null,
        limit: typeof limitValue === "number" ? limitValue : 200,
      }),
    );
  });

  return router;
}
