import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  extractClaims,
  type ClaimSource,
} from "../src/claims/extract.js";
import {
  appendTurn,
  createConversation,
} from "../src/conversations/repository.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import {
  FakeChat,
  FakeSearch,
  isExtractionRequest,
  type ChatResponder,
} from "./support/fakes.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TIMEZONE = "Asia/Kolkata";

const SOURCES: ClaimSource[] = [
  {
    id: "s1",
    title: "HubSpot pricing",
    url: "https://www.hubspot.com/pricing",
    publishedAt: "2026-11-12",
    snippet: "HubSpot Starter is 20 USD per seat per month.",
  },
  {
    id: "s2",
    title: "CRM pricing roundup",
    url: "https://crmblog.example/hubspot",
    publishedAt: "2025-03-04",
    snippet: "HubSpot Starter costs 15 USD per seat per month.",
  },
];

type ClaimRow = {
  id: string;
  subject_text: string;
  attribute: string;
  value_text: string | null;
  quote: string;
  status: string;
  supersedes_claim_id: string | null;
  source_id: string | null;
};

function claimsReply(claims: unknown[]): string {
  return JSON.stringify({ claims });
}

function verifiedClaim(overrides: Record<string, unknown> = {}): unknown {
  return {
    subject: "HubSpot Starter",
    attribute: "price",
    value: "20 USD per seat per month",
    quote: "HubSpot Starter is 20 USD per seat per month.",
    sourceId: "s1",
    unit: "per seat per month",
    currency: "USD",
    period: "monthly",
    ...overrides,
  };
}

let dir: string;
let db: Db;
let conversationId: string;

function newTurn(): string {
  return appendTurn(db, {
    conversationId,
    role: "assistant",
    content: "HubSpot Starter is 20 USD per seat per month [s1].",
    createdAt: NOW.toISOString(),
  }).id;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-claims-"));
  db = openDatabase(path.join(dir, "asof.db"));
  migrate(db);
  conversationId = createConversation(db, {
    title: "claims",
    timezone: TIMEZONE,
    now: NOW,
  }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function extract(
  reply: string,
  turnId = newTurn(),
  sources: ClaimSource[] = SOURCES,
) {
  const chat = new FakeChat(reply);
  const result = await extractClaims(
    db,
    { chat, model: "fake-extract" },
    {
      answer: "HubSpot Starter is 20 USD per seat per month [s1].",
      sources,
      turnId,
      conversationId,
      now: NOW,
      provider: "fake",
    },
  );
  return { result, chat, turnId };
}

describe("claim extraction", () => {
  it("stores a claim only when its quote appears verbatim in the cited evidence", async () => {
    const { result, turnId } = await extract(claimsReply([verifiedClaim()]));

    assert.equal(result.inserted, 1);
    assert.equal(result.dropped, 0);

    const claim = db
      .prepare(
        `SELECT id, subject_text, attribute, value_text, quote, status,
                supersedes_claim_id, source_id
         FROM claims WHERE turn_id = ?`,
      )
      .get(turnId) as ClaimRow | undefined;

    assert.ok(claim);
    assert.equal(claim?.subject_text, "HubSpot Starter");
    assert.equal(claim?.attribute, "price");
    assert.equal(claim?.status, "active");
    assert.equal(claim?.quote, SOURCES[0]?.snippet);
    assert.ok(claim?.source_id?.startsWith("src-"));

    const source = db
      .prepare("SELECT snippet, provider FROM sources WHERE id = ?")
      .get(claim?.source_id) as { snippet: string; provider: string } | undefined;
    assert.equal(source?.provider, "fake");
    assert.equal(source?.snippet, SOURCES[0]?.snippet);
  });

  it("drops a claim whose quote is paraphrased instead of copied", async () => {
    const { result } = await extract(
      claimsReply([
        verifiedClaim({ quote: "HubSpot Starter costs 20 USD each month" }),
      ]),
    );

    assert.equal(result.inserted, 0);
    assert.equal(result.dropped, 1);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM claims").get() as { count: number })
        .count,
      0,
    );
  });

  it("drops a claim that cites a source id it was not given", async () => {
    const { result } = await extract(claimsReply([verifiedClaim({ sourceId: "s9" })]));

    assert.equal(result.inserted, 0);
    assert.equal(result.dropped, 1);
  });

  it("supersedes the previous active claim on the same subject and attribute", async () => {
    await extract(claimsReply([verifiedClaim()]));
    const { result, turnId } = await extract(
      claimsReply([
        verifiedClaim({
          value: "15 USD per seat per month",
          quote: "HubSpot Starter costs 15 USD per seat per month.",
          sourceId: "s2",
        }),
      ]),
    );

    assert.equal(result.inserted, 1);
    assert.equal(result.superseded, 1);

    const rows = db
      .prepare(
        `SELECT id, value_text, status, supersedes_claim_id
         FROM claims ORDER BY created_at, rowid`,
      )
      .all() as ClaimRow[];

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, "superseded");
    assert.equal(rows[1]?.status, "active");
    assert.equal(rows[1]?.supersedes_claim_id, rows[0]?.id);
    assert.equal(
      (db.prepare("SELECT turn_id FROM claims WHERE id = ?").get(rows[1]?.id) as {
        turn_id: string;
      }).turn_id,
      turnId,
    );
  });

  it("keeps monthly and annual prices as separate active claims", async () => {
    await extract(claimsReply([verifiedClaim()]));
    const { result } = await extract(
      claimsReply([
        verifiedClaim({
          value: "15 USD per seat per month",
          quote: "HubSpot Starter costs 15 USD per seat per month.",
          sourceId: "s2",
          period: "annual",
        }),
      ]),
    );

    assert.equal(result.inserted, 1);
    assert.equal(result.superseded, 0);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM claims WHERE status = 'active'")
          .get() as { count: number }
      ).count,
      2,
    );
  });

  it("does not call the model when there are no sources to quote", async () => {
    const chat = new FakeChat(claimsReply([verifiedClaim()]));
    const result = await extractClaims(
      db,
      { chat, model: "fake-extract" },
      {
        answer: "Nothing was cited.",
        sources: [],
        turnId: newTurn(),
        conversationId,
        now: NOW,
        provider: "fake",
      },
    );

    assert.equal(result.inserted, 0);
    assert.equal(result.reason, "nothing to extract");
    assert.equal(chat.calls, 0);
  });
});

describe("claims wired into /ask", () => {
  const responder: ChatResponder = (request) =>
    isExtractionRequest(request)
      ? claimsReply([verifiedClaim()])
      : "HubSpot Starter is 20 USD per seat per month [s1].";

  async function ask(chat: FakeChat): Promise<{
    claims: { inserted: number; dropped: number; reason: string | null };
    assistantTurnId: string;
  }> {
    const app = createApp(db, {
      clock: () => NOW,
      search: new FakeSearch(),
      chat,
      model: "fake-model",
      extractModel: "fake-extract",
    });
    const response = await app.request(
      `http://localhost/api/conversations/${conversationId}/ask`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "what is hubspot starter pricing?" }),
      },
    );
    assert.equal(response.status, 200);
    return (await response.json()) as {
      claims: { inserted: number; dropped: number; reason: string | null };
      assistantTurnId: string;
    };
  }

  it("extracts claims from a grounded answer and marks the turn done", async () => {
    const body = await ask(new FakeChat(responder));

    assert.equal(body.claims.inserted, 1);
    assert.equal(body.claims.reason, null);

    const turn = db
      .prepare("SELECT claims_status FROM turns WHERE id = ?")
      .get(body.assistantTurnId) as { claims_status: string };
    assert.equal(turn.claims_status, "done");
  });

  it("skips extraction when the answer is not grounded", async () => {
    const body = await ask(
      new FakeChat((request) =>
        isExtractionRequest(request)
          ? claimsReply([verifiedClaim()])
          : "HubSpot Starter is 20 USD per seat per month.",
      ),
    );

    assert.equal(body.claims.inserted, 0);
    assert.equal(body.claims.reason, "answer was not grounded");

    const turn = db
      .prepare("SELECT claims_status FROM turns WHERE id = ?")
      .get(body.assistantTurnId) as { claims_status: string };
    assert.equal(turn.claims_status, "skipped");
  });

  it("keeps the answer when extraction fails, marking claims failed", async () => {
    const body = await ask(
      new FakeChat((request) =>
        isExtractionRequest(request)
          ? "this is not json"
          : "HubSpot Starter is 20 USD per seat per month [s1].",
      ),
    );

    assert.equal(body.claims.inserted, 0);
    assert.match(body.claims.reason ?? "", /JSON/i);

    const turn = db
      .prepare("SELECT claims_status FROM turns WHERE id = ?")
      .get(body.assistantTurnId) as { claims_status: string };
    assert.equal(turn.claims_status, "failed");
  });
});
