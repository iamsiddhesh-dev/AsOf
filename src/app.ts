import { Hono } from "hono";
import type { Db } from "./db/index.js";
import { conversationRoutes } from "./routes/conversations.js";
import { demoRoutes } from "./routes/demo.js";
import { memoryRoutes } from "./routes/memory.js";

export type AppOptions = {
  clock?: () => Date;
};

const LEDGER_TABLES = [
  "conversations",
  "turns",
  "claims",
  "sources",
  "watches",
] as const;

export function createApp(db: Db, options: AppOptions = {}) {
  const app = new Hono();
  const clock = options.clock ?? (() => new Date());

  app.get("/health", (c) => {
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number };
    return c.json({
      ok: row.ok === 1,
      service: "asof",
      version: "0.1.0",
      time: clock().toISOString(),
    });
  });

  app.get("/api/ledger/stats", (c) => {
    const counts: Record<string, number> = {};
    for (const table of LEDGER_TABLES) {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number };
      counts[table] = row.count;
    }

    const schema = db
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get() as { version: number };

    return c.json({
      schemaVersion: schema.version,
      counts,
    });
  });

  app.route("/api/conversations", conversationRoutes(db, options));
  app.route("/api/memory", memoryRoutes(db, options));
  app.route("/api/demo", demoRoutes(db, options));

  return app;
}
