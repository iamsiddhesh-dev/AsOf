import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  appendTurn,
  createConversation,
  type Conversation,
  type Turn,
} from "../src/conversations/repository.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TZ = "Asia/Kolkata";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-memory-"));
  db = openDatabase(path.join(dir, "asof.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createApp(db, { clock: () => NOW });
}

function makeConversation(title: string): Conversation {
  return createConversation(db, { title, timezone: TZ, now: NOW });
}

async function recall(text: string, extra: Record<string, unknown> = {}) {
  const response = await app().request("http://localhost/api/memory/recall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...extra }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as {
    found: boolean;
    range: { label: string } | null;
    turns: Turn[];
    message: string;
    memoryStartsAt: string | null;
    demo: boolean;
  };
}

describe("memory recall", () => {
  it("applies every migration in order on top of the first schema", () => {
    const columns = db
      .prepare("PRAGMA table_info(turns)")
      .all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "is_demo"));

    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3],
    );
  });

  it("recalls across every conversation, not just one", async () => {
    const first = makeConversation("crm shortlist");
    const second = makeConversation("hosting");

    appendTurn(db, {
      conversationId: first.id,
      role: "user",
      content: "We shortlisted five CRM tools.",
      createdAt: "2026-11-14T12:00:00.000Z",
    });
    appendTurn(db, {
      conversationId: second.id,
      role: "user",
      content: "We need managed Postgres with daily backups.",
      createdAt: "2026-11-14T13:00:00.000Z",
    });
    appendTurn(db, {
      conversationId: second.id,
      role: "user",
      content: "A question from today.",
      createdAt: "2026-11-15T05:00:00.000Z",
    });

    const result = await recall("what did i ask yesterday?");
    assert.equal(result.found, true);
    assert.equal(result.range?.label, "14 November 2026");
    assert.deepEqual(
      result.turns.map((turn) => turn.content),
      ["We shortlisted five CRM tools.", "We need managed Postgres with daily backups."],
    );
    assert.deepEqual(
      [...new Set(result.turns.map((turn) => turn.conversationTitle))],
      ["crm shortlist", "hosting"],
    );
  });

  it("says nothing is stored instead of inventing a 3 November", async () => {
    const result = await recall("what did i ask on 3 november?");
    assert.equal(result.found, false);
    assert.equal(result.turns.length, 0);
    assert.equal(result.range?.label, "3 November 2026");
    assert.match(result.message, /no record from 3 November 2026/i);
    assert.match(result.message, /nothing has been stored/i);
    assert.equal(result.memoryStartsAt, null);
  });

  it("names the first day the ledger holds when the window is empty", async () => {
    const conversation = makeConversation("crm shortlist");
    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "An early note.",
      createdAt: "2026-11-10T12:00:00.000Z",
    });

    const result = await recall("what did i ask on 3 november?");
    assert.equal(result.found, false);
    assert.match(result.message, /my memory starts 10 November 2026/i);
  });

  it("filters by keyword over stored text", async () => {
    const conversation = makeConversation("mixed");
    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "Managed Postgres with daily backups.",
      createdAt: "2026-11-14T12:00:00.000Z",
    });
    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "CRM pricing looks high.",
      createdAt: "2026-11-14T12:30:00.000Z",
    });

    const result = await recall("what did i ask yesterday?", { keyword: "postgres" });
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0]?.content, "Managed Postgres with daily backups.");
  });

  it("exposes memory stats", async () => {
    const conversation = makeConversation("crm shortlist");
    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "We shortlisted five CRM tools.",
      createdAt: "2026-11-14T12:00:00.000Z",
    });

    const response = await app().request("http://localhost/api/memory/stats");
    const body = (await response.json()) as {
      turns: number;
      conversations: number;
      demoConversations: number;
      firstTurnAt: string | null;
    };
    assert.equal(body.turns, 1);
    assert.equal(body.conversations, 1);
    assert.equal(body.demoConversations, 0);
    assert.equal(body.firstTurnAt, "2026-11-14T12:00:00.000Z");
  });
});

describe("demo history", () => {
  it("seeds dated turns relative to the clock and stays idempotent", async () => {
    const first = await app().request("http://localhost/api/demo/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: TZ }),
    });
    assert.equal(first.status, 201);
    const seeded = (await first.json()) as { created: boolean; turns: Turn[] };
    assert.equal(seeded.created, true);
    assert.equal(seeded.turns.length, 6);
    assert.ok(seeded.turns.every((turn) => turn.isDemo));

    const second = await app().request("http://localhost/api/demo/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: TZ }),
    });
    assert.equal(second.status, 200);
    const again = (await second.json()) as { created: boolean };
    assert.equal(again.created, false);

    const result = await recall("what did i ask yesterday?");
    assert.equal(result.found, true);
    assert.equal(result.demo, true);
    assert.match(result.message, /demo history/i);

    const monday = await recall("what did i ask last monday?");
    assert.equal(monday.found, true);
  });

  it("reports whether demo history is loaded", async () => {
    const before = await app().request("http://localhost/api/demo/history");
    assert.equal(((await before.json()) as { loaded: boolean }).loaded, false);

    await app().request("http://localhost/api/demo/history", { method: "POST" });

    const after = await app().request("http://localhost/api/demo/history");
    const body = (await after.json()) as { loaded: boolean; conversation: Conversation | null };
    assert.equal(body.loaded, true);
    assert.equal(body.conversation?.title, "Demo history");
  });
});
