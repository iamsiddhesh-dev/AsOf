import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { OpenAIChatClient } from "../src/providers/openai.js";
import { TavilySearchClient } from "../src/providers/tavily.js";
import { ProviderError } from "../src/providers/types.js";
import { CachedSearch } from "../src/search/cache.js";
import { FakeSearch } from "./support/fakes.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("openai-compatible chat client", () => {
  it("retries a rate limit and returns the completion with usage", async () => {
    let calls = 0;
    const client = new OpenAIChatClient({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      retries: 1,
      retryBaseMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" });
        }
        return jsonResponse({
          model: "test-model",
          choices: [{ message: { content: "cited answer [s1]" } }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        });
      },
    });

    const result = await client.chat({
      model: "test-model",
      messages: [{ role: "user", content: "question" }],
    });

    assert.equal(calls, 2);
    assert.equal(result.content, "cited answer [s1]");
    assert.deepEqual(result.usage, { input: 30, output: 12 });
  });

  it("does not retry a rejected key", async () => {
    let calls = 0;
    const client = new OpenAIChatClient({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      retries: 2,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: "bad key" }, 401);
      },
    });

    await assert.rejects(
      () =>
        client.chat({
          model: "test-model",
          messages: [{ role: "user", content: "question" }],
        }),
      (error: unknown) =>
        error instanceof ProviderError && error.status === 401,
    );
    assert.equal(calls, 1);
  });

  it("treats an empty completion as an error, naming the finish reason", async () => {
    const client = new OpenAIChatClient({
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      retries: 0,
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ message: { content: "" }, finish_reason: "length" }],
        }),
    });

    await assert.rejects(
      () =>
        client.chat({
          model: "test-model",
          messages: [{ role: "user", content: "question" }],
        }),
      /empty completion \(finish_reason: length\)/,
    );
  });
});

describe("tavily search client", () => {
  it("normalises results and drops rows without a title or url", async () => {
    const client = new TavilySearchClient({
      apiKey: "test",
      fetchImpl: async () =>
        jsonResponse({
          results: [
            {
              title: "HubSpot pricing",
              url: "https://hubspot.com/pricing",
              content: "Starter is 20 USD per seat.",
              published_date: "2026-11-12T00:00:00Z",
            },
            { title: "", url: "https://missing-title.test" },
          ],
        }),
    });

    const response = await client.search("hubspot pricing", { maxResults: 3 });

    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.publishedAt, "2026-11-12");
    assert.match(response.results[0]?.snippet ?? "", /20 USD/);
  });

  it("surfaces a rejected key", async () => {
    const client = new TavilySearchClient({
      apiKey: "test",
      fetchImpl: async () => jsonResponse({ error: "bad key" }, 401),
    });

    await assert.rejects(
      () => client.search("anything"),
      (error: unknown) =>
        error instanceof ProviderError && error.status === 401,
    );
  });
});

describe("search cache", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-cache-"));
    db = openDatabase(path.join(dir, "asof.db"));
    migrate(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("serves a second identical query from the cache", async () => {
    const inner = new FakeSearch();
    const cached = new CachedSearch(db, inner, () => new Date("2026-11-15T10:00:00Z"));

    const first = await cached.search("hubspot pricing");
    const second = await cached.search("hubspot pricing");

    assert.equal(inner.calls, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.results.length, first.results.length);
  });

  it("bypasses the cache when asked, which is what a recheck needs", async () => {
    const inner = new FakeSearch();
    const cached = new CachedSearch(db, inner, () => new Date("2026-11-15T10:00:00Z"));

    await cached.search("hubspot pricing");
    const fresh = await cached.search("hubspot pricing", { bypassCache: true });

    assert.equal(inner.calls, 2);
    assert.equal(fresh.cached, false);
  });

  it("refetches once the entry expires", async () => {
    const inner = new FakeSearch();
    let now = new Date("2026-11-15T10:00:00Z");
    const cached = new CachedSearch(db, inner, () => now, 1_000);

    await cached.search("hubspot pricing");
    now = new Date("2026-11-15T10:00:02Z");
    const afterExpiry = await cached.search("hubspot pricing");

    assert.equal(inner.calls, 2);
    assert.equal(afterExpiry.cached, false);
  });
});
