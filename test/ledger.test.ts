import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const NOW = "2026-11-15T10:00:00.000Z";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-test-"));
  db = openDatabase(path.join(dir, "asof.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedConversationAndTurn(): void {
  db.prepare(
    `INSERT INTO conversations
      (id, title, timezone, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("c1", "CRM shortlist", "Asia/Kolkata", "{}", NOW, NOW);

  db.prepare(
    `INSERT INTO turns
      (id, conversation_id, role, content, created_at, status, claims_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "t1",
    "c1",
    "user",
    "We shortlisted five CRM tools: HubSpot, Salesforce, Pipedrive, Zoho, Freshsales.",
    NOW,
    "done",
    "pending",
  );
}

describe("ledger foundation", () => {
  it("creates the full schema and applies migrations only once", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = new Set(rows.map((row) => row.name));

    for (const table of [
      "conversations",
      "turns",
      "entities",
      "entity_aliases",
      "entity_sets",
      "entity_set_members",
      "topics",
      "turn_topics",
      "turn_entities",
      "sources",
      "claims",
      "search_cache",
      "watches",
      "watch_events",
      "traces",
      "turns_fts",
    ]) {
      assert.ok(names.has(table), `missing table: ${table}`);
    }

    assert.deepEqual(migrate(db), []);
  });

  it("indexes turns for full-text recall", () => {
    seedConversationAndTurn();

    const hit = db
      .prepare("SELECT content FROM turns_fts WHERE turns_fts MATCH ?")
      .get("crm") as { content: string } | undefined;

    assert.ok(hit);
    assert.match(hit.content, /CRM/);
  });

  it("rejects a claim with no supporting quote", () => {
    seedConversationAndTurn();

    const insert = db.prepare(
      `INSERT INTO claims
        (id, turn_id, conversation_id, subject_text, attribute, quote,
         observed_at, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    assert.throws(() =>
      insert.run(
        "cl-bad",
        "t1",
        "c1",
        "HubSpot",
        "price",
        null,
        NOW,
        "hash-bad",
        NOW,
      ),
    );

    insert.run(
      "cl-1",
      "t1",
      "c1",
      "HubSpot",
      "price",
      "HubSpot costs $20 per seat.",
      NOW,
      "hash-1",
      NOW,
    );

    const claim = db
      .prepare("SELECT quote FROM claims WHERE id = ?")
      .get("cl-1") as { quote: string };
    assert.equal(claim.quote, "HubSpot costs $20 per seat.");
  });

  it("enforces foreign keys and exposes ledger stats", async () => {
    seedConversationAndTurn();
    const app = createApp(db);

    const health = await app.request("http://localhost/health");
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as {
      ok: boolean;
      service: string;
    };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, "asof");

    const stats = await app.request("http://localhost/api/ledger/stats");
    assert.equal(stats.status, 200);
    const statsBody = (await stats.json()) as {
      schemaVersion: number;
      counts: Record<string, number>;
    };
    assert.equal(statsBody.schemaVersion, 1);
    assert.equal(statsBody.counts.turns, 1);
    assert.equal(statsBody.counts.claims, 0);

    assert.throws(() =>
      db.prepare(
        `INSERT INTO turns
          (id, conversation_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("t2", "missing-conversation", "user", "orphan", NOW),
    );
  });
});
