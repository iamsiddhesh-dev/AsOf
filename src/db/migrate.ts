import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./index.js";

const defaultMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

type MigrationRow = { version: number };

export function migrate(db: Db, migrationsDir = defaultMigrationsDir): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => (row as MigrationRow).version),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );

  const newlyApplied: number[] = [];

  for (const file of files) {
    const version = Number(file.split("_", 1)[0]);
    if (!Number.isInteger(version)) {
      throw new Error(`invalid migration filename: ${file}`);
    }
    if (applied.has(version)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(version, new Date().toISOString());
    });

    apply();
    newlyApplied.push(version);
  }

  return newlyApplied;
}
