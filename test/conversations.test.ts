import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  appendTurn,
  getConversation,
  type Conversation,
  type Turn,
} from "../src/conversations/repository.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-conversations-"));
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

async function createConversation(): Promise<Conversation> {
  const response = await app().request("http://localhost/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "CRM shortlist",
      timezone: "Asia/Kolkata",
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()) as Conversation;
}

describe("conversation and turn api", () => {
  it("creates, lists, and fetches a conversation", async () => {
    const conversation = await createConversation();
    assert.equal(conversation.title, "CRM shortlist");
    assert.equal(conversation.timezone, "Asia/Kolkata");
    assert.equal(conversation.state.lastAnswerTurnId, null);

    const list = await app().request("http://localhost/api/conversations");
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { conversations: Conversation[] };
    assert.equal(listBody.conversations.length, 1);

    const get = await app().request(
      `http://localhost/api/conversations/${conversation.id}`,
    );
    assert.equal(get.status, 200);
    const getBody = (await get.json()) as Conversation;
    assert.equal(getBody.id, conversation.id);

    const missing = await app().request(
      "http://localhost/api/conversations/missing",
    );
    assert.equal(missing.status, 404);
  });

  it("resolves a date in a user turn and updates conversation state", async () => {
    const conversation = await createConversation();

    const response = await app().request(
      `http://localhost/api/conversations/${conversation.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "What did I ask on 3 November?",
        }),
      },
    );
    assert.equal(response.status, 201);
    const turn = (await response.json()) as Turn;
    assert.equal(turn.resolvedLabel, "3 November 2026");
    assert.equal(turn.resolvedStart, "2026-11-02T18:30:00.000Z");
    assert.equal(turn.resolvedEnd, "2026-11-03T18:30:00.000Z");

    const updated = getConversation(db, conversation.id);
    assert.ok(updated);
    assert.deepEqual(updated.state.resolvedTimeRange, {
      start: "2026-11-02T18:30:00.000Z",
      end: "2026-11-03T18:30:00.000Z",
      label: "3 November 2026",
    });
  });

  it("tracks the last assistant turn", async () => {
    const conversation = await createConversation();

    const response = await app().request(
      `http://localhost/api/conversations/${conversation.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "assistant",
          content: "Here is the shortlist.",
        }),
      },
    );
    assert.equal(response.status, 201);
    const turn = (await response.json()) as Turn;

    const updated = getConversation(db, conversation.id);
    assert.ok(updated);
    assert.equal(updated.state.lastAnswerTurnId, turn.id);
  });

  it("recalls turns by an exact date", async () => {
    const conversation = await createConversation();

    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "We shortlisted five CRM tools.",
      createdAt: "2026-11-03T12:00:00.000Z",
    });
    appendTurn(db, {
      conversationId: conversation.id,
      role: "assistant",
      content: "I recorded the shortlist.",
      createdAt: "2026-11-03T12:01:00.000Z",
    });
    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "A later question.",
      createdAt: "2026-11-04T12:00:00.000Z",
    });

    const response = await app().request(
      `http://localhost/api/conversations/${conversation.id}/turns?date=3%20november`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      range: { start: string; end: string; label: string };
      turns: Turn[];
    };
    assert.equal(body.range.label, "3 November 2026");
    assert.equal(body.turns.length, 2);
    assert.equal(body.turns[0]?.content, "We shortlisted five CRM tools.");
    assert.equal(body.turns[1]?.role, "assistant");
  });

  it("recalls yesterday relative to the conversation timezone", async () => {
    const conversation = await createConversation();

    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "What is on the CRM shortlist?",
      createdAt: "2026-11-14T12:00:00.000Z",
    });
    appendTurn(db, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Five tools are on the shortlist.",
      createdAt: "2026-11-14T12:01:00.000Z",
    });
    appendTurn(db, {
      conversationId: conversation.id,
      role: "user",
      content: "A question from today.",
      createdAt: "2026-11-15T05:00:00.000Z",
    });

    const response = await app().request(
      `http://localhost/api/conversations/${conversation.id}/turns?date=yesterday`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      range: { start: string; end: string; label: string };
      turns: Turn[];
    };
    assert.deepEqual(body.range, {
      start: "2026-11-13T18:30:00.000Z",
      end: "2026-11-14T18:30:00.000Z",
      label: "14 November 2026",
    });
    assert.deepEqual(
      body.turns.map((turn) => turn.content),
      ["What is on the CRM shortlist?", "Five tools are on the shortlist."],
    );
  });

  it("exposes the routing decision and stamps intent on user turns", async () => {
    const conversation = await createConversation();

    const decisionResponse = await app().request(
      `http://localhost/api/conversations/${conversation.id}/route`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "what did i ask yesterday?" }),
      },
    );
    assert.equal(decisionResponse.status, 200);
    const decision = (await decisionResponse.json()) as {
      intent: string;
      timeRange: { label: string } | null;
    };
    assert.equal(decision.intent, "recall");
    assert.equal(decision.timeRange?.label, "14 November 2026");

    const turnResponse = await app().request(
      `http://localhost/api/conversations/${conversation.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "user",
          content: "what did i ask on 3 november?",
        }),
      },
    );
    assert.equal(turnResponse.status, 201);
    const turn = (await turnResponse.json()) as Turn;
    assert.equal(turn.intent, "recall");

    const missingText = await app().request(
      `http://localhost/api/conversations/${conversation.id}/route`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(missingText.status, 400);
  });

  it("rejects an invalid date and an invalid role", async () => {
    const conversation = await createConversation();

    const badDate = await app().request(
      `http://localhost/api/conversations/${conversation.id}/turns?date=31%20february`,
    );
    assert.equal(badDate.status, 400);

    const badRole = await app().request(
      `http://localhost/api/conversations/${conversation.id}/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "wizard", content: "hello" }),
      },
    );
    assert.equal(badRole.status, 400);
  });
});
