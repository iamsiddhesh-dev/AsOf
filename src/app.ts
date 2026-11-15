import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config } from "./config.js";
import type { Db } from "./db/index.js";
import { createChatClient, createFastChatClient, createSearchClient } from "./providers/index.js";
import type { ChatClient, SearchClient } from "./providers/types.js";
import { answerRoutes } from "./routes/answer.js";
import { conversationRoutes } from "./routes/conversations.js";
import { demoRoutes } from "./routes/demo.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { memoryRoutes } from "./routes/memory.js";

export type AppOptions = {
  clock?: () => Date;
  /** Injected by the eval and tests. `null` means "not configured". */
  search?: SearchClient | null;
  chat?: ChatClient | null;
  extractChat?: ChatClient | null;
  model?: string;
  extractModel?: string;
  /**
   * Serve the built UI from this process. Off by default: tests create the app
   * without a build on disk, and an SPA fallback would swallow their 404s.
   */
  ui?: boolean;
  uiDir?: string;
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
  app.route("/api/ledger", ledgerRoutes(db));
  app.route("/api/conversations", answerRoutes(db, {
    clock,
    search:
      options.search !== undefined
        ? options.search
        : createSearchClient(db, clock),
    chat: options.chat !== undefined ? options.chat : createChatClient(),
    extractChat:
      options.extractChat !== undefined
        ? options.extractChat
        : options.chat !== undefined
          ? options.chat
          : createFastChatClient(),
    model: options.model ?? config.model.main.model,
    extractModel: options.extractModel ?? config.model.fast.model,
  }));
  app.route("/api/memory", memoryRoutes(db, options));
  app.route("/api/demo", demoRoutes(db, options));

  if (options.ui === true) {
    const uiDir = path.resolve(
      options.uiDir ?? path.join(process.cwd(), "web", "dist"),
    );
    const indexPath = path.join(uiDir, "index.html");

    if (fs.existsSync(indexPath)) {
      // Hashed assets and any other real file. Requests that find nothing call
      // next(), so a client-side route falls through to the document below.
      app.use("/*", serveStatic({ root: uiDir }));

      app.get("*", (c, next) => {
        // The API keeps JSON 404s: only a browser navigation gets the app.
        if (c.req.path.startsWith("/api/")) {
          return next();
        }
        // A missing asset is a 404, not a document. Falling back here would
        // return HTML with a JS content type for a stale bundle and hide the
        // real problem behind a syntax error in the console.
        if (/\.[a-z0-9]+$/i.test(c.req.path)) {
          return next();
        }
        return serveStatic({
          root: uiDir,
          rewriteRequestPath: () => "/index.html",
        })(c, next);
      });
    }
  }

  return app;
}
