import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { createConversation } from "../src/conversations/repository.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import type { ChatRequest } from "../src/providers/types.js";
import {
  DEFAULT_REPLY,
  FakeChat,
  FakeSearch,
  isExtractionRequest,
  isRecheckRequest,
} from "./support/fakes.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TIMEZONE = "Asia/Kolkata";

const EXTRACTION = JSON.stringify({
  claims: [
    {
      subject: "HubSpot",
      attribute: "starter_price",
      value: "20 USD per seat per month",
      quote: "HubSpot Starter is 20 USD per seat per month.",
      sourceId: "s1",
      unit: "USD/seat/month",
      currency: "USD",
      period: "month",
    },
  ],
});

/**
 * Synthesis answers with the fixture reply, extraction stores one claim, and a
 * recheck reports the price moved to 15 USD with a verbatim quote from s2.
 */
function responder(request: ChatRequest): string {
  if (isRecheckRequest(request)) {
    const user = request.messages.find((message) => message.role === "user");
    const claimId = /claimId: ([^\s]+)/.exec(user?.content ?? "")?.[1] ?? "";
    return JSON.stringify({
      verdicts: [
        {
          claimId,
          status: "changed",
          value: "15 USD per seat per month",
          quote: "HubSpot Starter costs 15 USD per seat per month.",
          sourceId: "s2",
          reason: "the newer source lists 15 USD",
        },
      ],
    });
  }

  if (isExtractionRequest(request)) {
    return EXTRACTION;
  }

  return DEFAULT_REPLY;
}

type ClaimBody = {
  id: string;
  subject: string;
  attribute: string;
  value: string | null;
  status: string;
  quote: string;
  supersedesClaimId: string | null;
  source: { url: string; domain: string; publishedAt: string | null } | null;
};

type TurnsBody = {
  turns: Array<{
    role: string;
    content: string;
    sources: Array<{ label: string; url: string; snippet: string | null }>;
  }>;
};

describe("ledger read api", () => {
  let dir: string;
  let db: Db;
  let conversationId: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-ledger-read-"));
    db = openDatabase(path.join(dir, "asof.db"));
    migrate(db);
    conversationId = createConversation(db, {
      title: "pricing notes",
      timezone: TIMEZONE,
      now: NOW,
    }).id;
    app = createApp(db, {
      clock: () => NOW,
      search: new FakeSearch(),
      chat: new FakeChat(responder),
      model: "fake-model",
      extractModel: "fake-fast",
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function ask(text: string): Promise<void> {
    const response = await app.request(
      `http://localhost/api/conversations/${conversationId}/ask`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );
    assert.equal(response.status, 200);
  }

  async function claims(
    query = "",
  ): Promise<{ status: number; claims: ClaimBody[]; total: number }> {
    const response = await app.request(
      `http://localhost/api/ledger/claims${query}`,
    );
    const body = (await response.json()) as {
      claims: ClaimBody[];
      total: number;
      error?: string;
    };
    return { status: response.status, claims: body.claims ?? [], total: body.total ?? 0 };
  }

  it("attaches citations to the answering turn", async () => {
    await ask("what is hubspot starter pricing?");

    const response = await app.request(
      `http://localhost/api/conversations/${conversationId}/turns`,
    );
    const body = (await response.json()) as TurnsBody;

    const assistant = body.turns.find((turn) => turn.role === "assistant");
    assert.ok(assistant !== undefined);
    assert.deepEqual(
      assistant.sources.map((source) => source.label),
      ["s1", "s2"],
    );
    assert.equal(assistant.sources[0]?.url, "https://www.hubspot.com/pricing");
    assert.match(assistant.sources[0]?.snippet ?? "", /20 USD/);

    const user = body.turns.find((turn) => turn.role === "user");
    assert.deepEqual(user?.sources, []);
  });

  it("lists active claims with the evidence behind them", async () => {
    await ask("what is hubspot starter pricing?");

    const page = await claims();
    assert.equal(page.status, 200);
    assert.equal(page.total, 1);
    assert.equal(page.claims.length, 1);

    const claim = page.claims[0];
    assert.equal(claim?.subject, "HubSpot");
    assert.equal(claim?.attribute, "starter_price");
    assert.equal(claim?.value, "20 USD per seat per month");
    assert.equal(claim?.status, "active");
    assert.equal(claim?.source?.domain, "hubspot.com");
    assert.equal(claim?.source?.publishedAt, "2026-11-12");
    assert.match(claim?.quote ?? "", /20 USD per seat/);
    assert.equal(claim?.supersedesClaimId, null);
  });

  it("returns the supersession chain oldest first", async () => {
    await ask("what is hubspot starter pricing?");
    const before = (await claims()).claims[0];
    assert.ok(before !== undefined);

    await ask("has hubspot pricing changed?");

    const all = await claims("?status=all");
    assert.equal(all.total, 2);
    assert.deepEqual(
      all.claims
        .map((claim) => claim.status)
        .sort(),
      ["active", "superseded"],
    );

    const response = await app.request(
      `http://localhost/api/ledger/claims/${before.id}`,
    );
    const body = (await response.json()) as {
      claim: ClaimBody;
      history: ClaimBody[];
    };

    assert.equal(response.status, 200);
    assert.equal(body.claim.id, before.id);
    assert.deepEqual(
      body.history.map((claim) => claim.status),
      ["superseded", "active"],
    );
    assert.equal(body.history[1]?.value, "15 USD per seat per month");
    assert.equal(body.history[1]?.supersedesClaimId, before.id);

    // Only the active claim is in the default view, and only the old chain
    // counts as history: the ledger did not grow two unrelated subjects.
    const active = await claims();
    assert.equal(active.total, 1);
    assert.equal(active.claims[0]?.value, "15 USD per seat per month");
  });

  it("groups the ledger by subject", async () => {
    await ask("what is hubspot starter pricing?");
    await ask("has hubspot pricing changed?");

    const response = await app.request("http://localhost/api/ledger/subjects");
    const body = (await response.json()) as {
      subjects: Array<{ subject: string; active: number; superseded: number }>;
    };

    assert.equal(body.subjects.length, 1);
    assert.equal(body.subjects[0]?.subject, "HubSpot");
    assert.equal(body.subjects[0]?.active, 1);
    assert.equal(body.subjects[0]?.superseded, 1);
  });

  it("filters by status and subject", async () => {
    await ask("what is hubspot starter pricing?");

    assert.equal((await claims("?status=superseded")).total, 0);
    assert.equal((await claims("?subject=salesforce")).total, 0);
    assert.equal((await claims("?q=starter")).total, 1);

    const bad = await claims("?status=deleted");
    assert.equal(bad.status, 400);
  });

  it("returns 404 for a claim that does not exist", async () => {
    const response = await app.request(
      "http://localhost/api/ledger/claims/claim-missing",
    );
    assert.equal(response.status, 404);
  });
});
