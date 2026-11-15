import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { openDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";

const db = openDatabase(config.databasePath);
const applied = migrate(db);
const app = createApp(db);

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`asof listening on http://localhost:${info.port}`);
    console.log(`database: ${config.databasePath}`);
    if (applied.length > 0) {
      console.log(`applied migrations: ${applied.join(", ")}`);
    }
  },
);

function shutdown(signal: string): void {
  console.log(`\n${signal}: closing asof`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
