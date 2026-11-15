import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  claimContentHash,
  storeClaim,
} from "../src/claims/store.js";
import {
  appendTurn,
  createConversation,
  listTurns,
} from "../src/conversations/repository.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { OpenAIChatClient, readSseData } from "../src/providers/openai.js";
import { ProviderError } from "../src/providers/types.js";
import {
  DEFAULT_REPLY,
  FakeChat,
  FakeSearch,
} from "./support/fakes.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TIMEZONE = "Asia/Kolkata";
const HUBSPOT_QUOTE = "HubSpot Starter is 20 USD per seat per month.";

type SseEvent = { event: string; data: Record<string, unknown> };

/**
 * Minimal SSE reader for assertions. It mirrors the contract the browser
 * client will use: `event:` names the message, `data:` is JSON.
 */
function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];

  for (const frame of text.split("\n\n")) {
    const lines = frame.split("\n");
    const event =
      lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
    const data = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");

    if (data.length === 0) {
      continue;
    }

    events.push({ event, data: JSON.parse(data) as Record<string, unknown> });
  }

  return events;
}

function frameStream(...frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

describe("sse framing", () => {
  it("reassembles a data frame split across two network reads", async () => {
    const body = frameStream(
      'data: {"choices":[{"delta":{"cont',
      'ent":"hi"}}]}\n\ndata: [DONE]\n\n',
    );

    const frames: string[] = [];
    for await (const data of readSseData(body)) {
      frames.push(data);
    }

    assert.deepEqual(frames, ['{"choices":[{"delta":{"content":"hi"}}]}', "[DONE]"]);
  });

  it("ignores comment keep-alives that carry no data line", async () => {
    const body = frameStream(": ping\n\n", "data: [DONE]\n\n");

    const frames: string[] = [];
    for await (const data of readSseData(body)) {
      frames.push(data);
    }

    assert.deepEqual(frames, ["[DONE]"]);
  });
});

describe("openai-compatible streaming", () => {
  it("forwards deltas in order and keeps the reported usage", async () => {
    let sent: Record<string, unknown> = {};
    const body = [
      'data: {"model":"test-model","choices":[{"delta":{"content":"HubSpot "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Starter is 20 USD [s1]."}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":12}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const client = new OpenAIChatClient({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      retries: 0,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const deltas: string[] = [];
    const result = await client.stream(
      { model: "test-model", messages: [{ role: "user", content: "q" }] },
      (delta) => {
        deltas.push(delta);
      },
    );

    assert.deepEqual(deltas, ["HubSpot ", "Starter is 20 USD [s1]."]);
    assert.equal(result.content, "HubSpot Starter is 20 USD [s1].");
    assert.deepEqual(result.usage, { input: 30, output: 12 });
    assert.equal(sent["stream"], true);
    assert.deepEqual(sent["stream_options"], { include_usage: true });
  });

  it("treats a stream with no tokens as an empty completion", async () => {
    const client = new OpenAIChatClient({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      retries: 0,
      fetchImpl: async () =>
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    await assert.rejects(
      () =>
        client.stream(
          { model: "test-model", messages: [{ role: "user", content: "q" }] },
          () => {},
        ),
      /empty completion \(stream produced no tokens\)/,
    );
  });
});

describe("streaming endpoint", () => {
  let dir: string;
  let db: Db;
  let conversationId: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-stream-"));
    db = openDatabase(path.join(dir, "asof.db"));
    migrate(db);
    conversationId = createConversation(db, {
      title: "stream",
      timezone: TIMEZONE,
      now: NOW,
    }).id;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function ask(
    text: string,
    chat: FakeChat,
  ): Promise<{ status: number; contentType: string | null; events: SseEvent[] }> {
    const app = createApp(db, {
      clock: () => NOW,
      search: new FakeSearch(),
      chat,
      model: "fake-model",
      extractModel: "fake-fast",
    });

    const response = await app.request(
      `http://localhost/api/conversations/${conversationId}/ask/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );

    const raw = await response.text();

    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      events: parseSse(raw),
    };
  }

  function seedClaim(): void {
    const turn = appendTurn(db, {
      conversationId,
      role: "assistant",
      content: `HubSpot is 20 USD [s1].`,
      createdAt: NOW.toISOString(),
    });

    storeClaim(db, {
      turnId: turn.id,
      conversationId,
      subject: "HubSpot",
      attribute: "starter_price",
      claimType: "price",
      value: "20 USD per seat per month",
      unit: "USD/seat/month",
      currency: "USD",
      period: "month",
      confidence: 0.8,
      sourceRowId: null,
      quote: HUBSPOT_QUOTE,
      observedAt: NOW.toISOString(),
      contentHash: claimContentHash({
        subject: "HubSpot",
        attribute: "starter_price",
        value: "20 USD per seat per month",
        sourceId: null,
        quote: HUBSPOT_QUOTE,
      }),
      createdAt: NOW.toISOString(),
    });
  }

  it("streams a search answer, then writes both turns", async () => {
    const chat = new FakeChat();
    const { status, contentType, events } = await ask(
      "what is hubspot starter pricing?",
      chat,
    );

    assert.equal(status, 200);
    assert.match(contentType ?? "", /text\/event-stream/);
    assert.equal(events[0]?.event, "decision");

    const names = events.map((entry) => entry.event);
    assert.ok(names.includes("sources"));
    assert.ok(names.includes("delta"));
    assert.equal(names.at(-1), "done");

    const deltas = events
      .filter((entry) => entry.event === "delta")
      .map((entry) => String(entry.data["text"]));
    assert.ok(deltas.length > 1, "the answer should arrive in several deltas");
    assert.equal(deltas.join(""), DEFAULT_REPLY);

    // A streamed synthesis is not repeated as a block.
    assert.equal(names.includes("block"), false);

    const done = events.at(-1)?.data ?? {};
    assert.equal(done["answer"], DEFAULT_REPLY);
    assert.equal(done["grounded"], true);

    const turns = listTurns(db, conversationId);
    assert.deepEqual(
      turns.map((turn) => turn.role),
      ["user", "assistant"],
    );
    assert.equal(turns[1]?.content, DEFAULT_REPLY);
    assert.equal(turns[1]?.claimsStatus, "done");
  });

  it("sends a recall as one block, because it was never generated", async () => {
    appendTurn(db, {
      conversationId,
      role: "user",
      content: "what is hubspot starter pricing?",
      createdAt: "2026-11-14T04:00:00.000Z",
    });

    const { events } = await ask("what did i ask on 14 november?", new FakeChat());

    const names = events.map((entry) => entry.event);
    assert.equal(names.includes("delta"), false);

    const block = events.find((entry) => entry.event === "block");
    assert.equal(block?.data["kind"], "recall");
    assert.equal(block?.data["index"], 0);

    const done = events.at(-1)?.data ?? {};
    assert.match(String(done["answer"]), /From 14 November 2026/);
    assert.match(String(done["answer"]), /what is hubspot starter pricing\?/);
  });

  it("emits sources before the recheck verdict block", async () => {
    seedClaim();

    const { events } = await ask(
      "has hubspot pricing changed?",
      new FakeChat(),
    );

    const names = events.map((entry) => entry.event);
    const sourcesAt = names.indexOf("sources");
    const blockAt = names.indexOf("block");
    assert.ok(sourcesAt !== -1 && blockAt !== -1);
    assert.ok(sourcesAt < blockAt, "sources should arrive before the verdict");

    const block = events[blockAt];
    assert.equal(block?.data["kind"], "recheck");
    assert.match(String(block?.data["text"]), /is still 20 USD/);

    const done = events.at(-1)?.data ?? {};
    assert.equal(done["grounded"], true);
    assert.equal(done["claimsStatus"], "done");
  });

  it("reports a provider failure as an event and still records the question", async () => {
    const chat = new FakeChat(() => {
      throw new ProviderError("model", "provider exploded", 503);
    });

    const { status, events } = await ask(
      "what is hubspot starter pricing?",
      chat,
    );

    assert.equal(status, 200);
    const error = events.at(-1);
    assert.equal(error?.event, "error");
    assert.equal(error?.data["message"], "provider exploded");
    assert.equal(error?.data["provider"], "model");
    assert.equal(error?.data["retryable"], true);
    assert.equal(events.some((entry) => entry.event === "done"), false);

    const turns = listTurns(db, conversationId);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.role, "user");
  });

  it("rejects an empty question before opening a stream", async () => {
    const app = createApp(db, {
      clock: () => NOW,
      search: new FakeSearch(),
      chat: new FakeChat(),
      model: "fake-model",
      extractModel: "fake-fast",
    });

    const response = await app.request(
      `http://localhost/api/conversations/${conversationId}/ask/stream`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      },
    );

    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  });
});
