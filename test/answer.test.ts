import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  appendTurn,
  createConversation,
  listTurns,
} from "../src/conversations/repository.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { FakeChat, FakeSearch } from "./support/fakes.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TIMEZONE = "Asia/Kolkata";
const YESTERDAY = "2026-11-14T04:30:00.000Z";

type AskBody = {
  answer: string;
  grounded: boolean | null;
  citations: Array<{ id: string; title: string; url: string }>;
  steps: Array<{ action: string; status: string; detail: string }>;
  model: string | null;
  demo: boolean;
  blockedBy: string | null;
  userTurnId: string;
  assistantTurnId: string;
  decision: {
    intent: string;
    steps: Array<{ action: string; mode: string | null }>;
  };
};

let dir: string;
let db: Db;
let conversationId: string;
let search: FakeSearch;
let chat: FakeChat;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-answer-"));
  db = openDatabase(path.join(dir, "asof.db"));
  migrate(db);
  conversationId = createConversation(db, {
    title: "ask",
    timezone: TIMEZONE,
    now: NOW,
  }).id;
  search = new FakeSearch();
  chat = new FakeChat();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function ask(text: string): Promise<{ status: number; body: AskBody }> {
  const app = createApp(db, {
    clock: () => NOW,
    search,
    chat,
    model: "fake-model",
  });
  const response = await app.request(
    `http://localhost/api/conversations/${conversationId}/ask`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  return { status: response.status, body: (await response.json()) as AskBody };
}

describe("answer path", () => {
  it("answers a factual question with citations and writes both turns", async () => {
    const { status, body } = await ask("what is hubspot starter pricing?");

    assert.equal(status, 200);
    assert.equal(body.grounded, true);
    assert.equal(body.citations.length, 2);
    assert.equal(body.citations[0]?.id, "s1");
    assert.match(body.answer, /\[s1\]/);
    assert.deepEqual(
      body.steps.map((step) => [step.action, step.status]),
      [["search", "done"]],
    );

    const turns = listTurns(db, conversationId);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.role, "user");
    assert.equal(turns[0]?.intent, "search");
    assert.equal(turns[1]?.role, "assistant");
    assert.equal(turns[1]?.parentTurnId, body.userTurnId);
    assert.equal(turns[1]?.model, "fake-model");
    assert.equal(turns[1]?.tokenIn, 100);
  });

  it("refuses to answer when search finds nothing, and does not call the model", async () => {
    search = new FakeSearch([]);

    const { body } = await ask("what is hubspot starter pricing?");

    assert.equal(body.grounded, false);
    assert.equal(body.citations.length, 0);
    assert.match(body.answer, /won't guess/i);
    assert.equal(chat.calls, 0);
  });

  it("marks an answer grounded only when it cites a real source", async () => {
    chat = new FakeChat("HubSpot Starter is 20 USD per seat per month.");

    const { body } = await ask("what is hubspot starter pricing?");

    assert.equal(body.grounded, false);
    assert.equal(body.citations.length, 2);
  });

  it("ignores citation ids that no source backs", async () => {
    chat = new FakeChat("HubSpot Starter is 20 USD per seat per month [s9].");

    const { body } = await ask("what is hubspot starter pricing?");

    assert.equal(body.grounded, false);
  });

  it("says it has no stored claims instead of guessing about a change", async () => {
    appendTurn(db, {
      conversationId,
      role: "user",
      content: "HubSpot Starter is 20 USD per seat per month.",
      createdAt: YESTERDAY,
    });
    appendTurn(db, {
      conversationId,
      role: "assistant",
      content: "HubSpot Starter costs 20 USD per seat per month [s1].",
      createdAt: "2026-11-14T04:31:00.000Z",
    });

    const { body } = await ask("has it changed since yesterday?");

    assert.deepEqual(
      body.steps.map((step) => [step.action, step.status]),
      [["recheck", "blocked"]],
    );
    assert.match(body.answer, /no stored claims/i);
    assert.equal(search.calls, 0);
    assert.equal(chat.calls, 0);
  });

  it("asks for the missing referent instead of searching a pronoun", async () => {
    const { body } = await ask("has any of them changed pricing?");

    assert.deepEqual(body.steps, []);
    assert.equal(body.blockedBy, "no_entity_set");
    assert.match(body.answer, /Name the tools or topics/i);
    assert.equal(search.calls, 0);
  });

  it("answers a greeting without a provider call", async () => {
    const { status, body } = await ask("hello");

    assert.equal(status, 200);
    assert.match(body.answer, /AsOf/);
    assert.deepEqual(
      body.steps.map((step) => [step.action, step.status]),
      [["chat", "done"]],
    );
    assert.equal(search.calls, 0);
    assert.equal(chat.calls, 0);
  });

  it("rejects an empty question before writing anything", async () => {
    const { status } = await ask("   ");

    assert.equal(status, 400);
    assert.equal(listTurns(db, conversationId).length, 0);
  });
});
