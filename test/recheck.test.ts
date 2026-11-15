import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import {
  applyClaimUpdates,
  recheckClaims,
  selectClaims,
} from "../src/recheck/compare.js";
import {
  claimContentHash,
  storeClaim,
} from "../src/claims/store.js";
import {
  appendTurn,
  createConversation,
} from "../src/conversations/repository.js";
import { emptyConversationState } from "../src/conversations/state.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import {
  DEFAULT_REPLY,
  FakeChat,
  FakeSearch,
  isRecheckRequest,
  type ChatResponder,
} from "./support/fakes.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TIMEZONE = "Asia/Kolkata";

const VERBATIM_20 = "HubSpot Starter is 20 USD per seat per month.";
const VERBATIM_15 = "HubSpot Starter costs 15 USD per seat per month.";

let dir: string;
let db: Db;
let conversationId: string;
let search: FakeSearch;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asof-recheck-"));
  db = openDatabase(path.join(dir, "asof.db"));
  migrate(db);
  conversationId = createConversation(db, {
    title: "recheck",
    timezone: TIMEZONE,
    now: NOW,
  }).id;
  search = new FakeSearch();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedClaim(
  input: {
    subject?: string;
    attribute?: string;
    value?: string;
    quote?: string;
    observedAt?: string;
  } = {},
): string {
  const subject = input.subject ?? "HubSpot";
  const attribute = input.attribute ?? "starter_price";
  const value = input.value ?? "20 USD per seat per month";
  const quote = input.quote ?? VERBATIM_20;
  const observedAt = input.observedAt ?? NOW.toISOString();

  const turn = appendTurn(db, {
    conversationId,
    role: "assistant",
    content: `${subject} is ${value} [s1].`,
    createdAt: observedAt,
  });

  const result = storeClaim(db, {
    turnId: turn.id,
    conversationId,
    subject,
    attribute,
    claimType: "price",
    value,
    unit: "USD/seat/month",
    currency: "USD",
    period: "month",
    confidence: 0.9,
    sourceRowId: null,
    quote,
    observedAt,
    contentHash: claimContentHash({
      subject,
      attribute,
      value,
      sourceId: null,
      quote,
    }),
    createdAt: observedAt,
  });

  return result.id;
}

function recheckResponder(
  verdict: (claimId: string) => Record<string, unknown>,
): ChatResponder {
  return (request) => {
    if (!isRecheckRequest(request)) {
      return DEFAULT_REPLY;
    }
    const user = request.messages.find((message) => message.role === "user");
    const claimId = /claimId: ([^\s]+)/.exec(user?.content ?? "")?.[1] ?? "";
    return JSON.stringify({ verdicts: [verdict(claimId)] });
  };
}

async function compare(responder: ChatResponder, text = "has it changed?") {
  const chat = new FakeChat(responder);
  const result = await recheckClaims(
    db,
    { search, chat, model: "fake-compare" },
    { text, now: NOW, activeEntities: [], firstIndex: 0 },
  );
  return { result, chat };
}

function claimRows(): Array<{
  id: string;
  subject_text: string;
  value_text: string | null;
  status: string;
  supersedes_claim_id: string | null;
  source_id: string | null;
}> {
  return db
    .prepare(
      `SELECT id, subject_text, value_text, status, supersedes_claim_id, source_id
       FROM claims ORDER BY created_at, rowid`,
    )
    .all() as Array<{
    id: string;
    subject_text: string;
    value_text: string | null;
    status: string;
    supersedes_claim_id: string | null;
    source_id: string | null;
  }>;
}

describe("recheck comparison", () => {
  it("reports a changed value and prepares a claim update", async () => {
    seedClaim();

    const { result } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "changed",
        value: "15 USD per seat per month",
        quote: VERBATIM_15,
        sourceId: "s2",
        reason: "the newer source lists 15 USD",
      })),
    );

    assert.equal(result.status, "done");
    assert.equal(result.grounded, true);
    assert.equal(result.verdicts.length, 1);
    assert.equal(result.verdicts[0]?.status, "changed");
    assert.equal(result.claimUpdates.length, 1);
    assert.match(result.text, /changed from 20 USD per seat per month to 15 USD/);
    assert.match(result.text, /\[s2\]/);
    assert.equal(result.citations.length, 2);
  });

  it("reports an unchanged value without preparing a write", async () => {
    seedClaim();

    const { result } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "unchanged",
        value: null,
        quote: VERBATIM_20,
        sourceId: "s1",
        reason: "same value",
      })),
    );

    assert.equal(result.status, "done");
    assert.equal(result.grounded, true);
    assert.equal(result.verdicts[0]?.status, "unchanged");
    assert.equal(result.claimUpdates.length, 0);
    assert.match(result.text, /is still 20 USD/);
  });

  it("downgrades a paraphrased change to an honest unknown", async () => {
    seedClaim();

    const { result } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "changed",
        value: "15 USD per seat per month",
        quote: "HubSpot now costs 15 USD each month",
        sourceId: "s2",
      })),
    );

    assert.equal(result.verdicts[0]?.status, "unknown");
    assert.equal(result.claimUpdates.length, 0);
    assert.equal(result.grounded, false);
    assert.match(result.text, /won't claim it changed/);
    assert.match(result.verdicts[0]?.reason ?? "", /verbatim/);
  });

  it("downgrades an unknown source id to unknown", async () => {
    seedClaim();

    const { result } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "changed",
        value: "15 USD per seat per month",
        quote: VERBATIM_15,
        sourceId: "s9",
      })),
    );

    assert.equal(result.verdicts[0]?.status, "unknown");
    assert.equal(result.claimUpdates.length, 0);
  });

  it("does not search or call the model when no claim is stored", async () => {
    const { result, chat } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "unchanged",
        quote: VERBATIM_20,
        sourceId: "s1",
      })),
    );

    assert.equal(result.status, "blocked");
    assert.match(result.text, /no stored claims/i);
    assert.equal(search.calls, 0);
    assert.equal(chat.calls, 0);
  });

  it("does not call the model when the fresh search finds nothing", async () => {
    seedClaim();
    search = new FakeSearch([]);

    const { result, chat } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "unchanged",
        quote: VERBATIM_20,
        sourceId: "s1",
      })),
    );

    assert.equal(result.status, "blocked");
    assert.match(result.text, /won't claim that nothing changed/);
    assert.equal(chat.calls, 0);
  });

  it("prefers a claim whose subject the question names", () => {
    seedClaim();
    seedClaim({
      subject: "Salesforce",
      attribute: "starter_price",
      value: "25 USD per seat per month",
      quote: "Salesforce Starter is 25 USD per seat per month.",
    });

    const selected = selectClaims(db, "has salesforce pricing changed?", [], 3);

    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.subject_text, "Salesforce");
  });

  it("does not check an unrelated claim when the question names another subject", () => {
    seedClaim();

    const selected = selectClaims(db, "has salesforce pricing changed?", [], 3);

    assert.deepEqual(selected, []);
  });

  it("says the subject is missing instead of checking an unrelated claim", async () => {
    seedClaim();

    const { result, chat } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "unchanged",
        quote: VERBATIM_20,
        sourceId: "s1",
      })),
      "has salesforce pricing changed?",
    );

    assert.equal(result.status, "blocked");
    assert.match(result.text, /no stored claims about that subject/i);
    assert.equal(search.calls, 0);
    assert.equal(chat.calls, 0);
  });
});

describe("storing recheck changes", () => {
  it("supersedes the compared claim and keeps the old row", async () => {
    const oldId = seedClaim();
    const { result } = await compare(
      recheckResponder((claimId) => ({
        claimId,
        status: "changed",
        value: "15 USD per seat per month",
        quote: VERBATIM_15,
        sourceId: "s2",
      })),
    );

    const turn = appendTurn(db, {
      conversationId,
      role: "assistant",
      content: result.text,
      createdAt: NOW.toISOString(),
    });

    const applied = applyClaimUpdates(db, result.claimUpdates, {
      turnId: turn.id,
      conversationId,
      now: NOW,
    });

    assert.deepEqual(applied, { inserted: 1, superseded: 1 });

    const rows = claimRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.id, oldId);
    assert.equal(rows[0]?.status, "superseded");
    assert.equal(rows[1]?.status, "active");
    assert.equal(rows[1]?.value_text, "15 USD per seat per month");
    assert.equal(rows[1]?.supersedes_claim_id, oldId);
    assert.ok(rows[1]?.source_id?.startsWith("src-"));
  });
});

describe("recheck wired into /ask", () => {
  type AskBody = {
    answer: string;
    grounded: boolean | null;
    citations: Array<{ id: string }>;
    steps: Array<{ action: string; status: string }>;
    claims: { inserted: number; superseded: number; reason: string | null };
    assistantTurnId: string;
    claimUpdates?: unknown;
  };

  async function ask(
    text: string,
    chat: FakeChat,
  ): Promise<{ status: number; body: AskBody }> {
    const app = createApp(db, {
      clock: () => NOW,
      search,
      chat,
      model: "fake-model",
      extractModel: "fake-fast",
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

  it("answers a recheck with cited verdicts and writes the change", async () => {
    const oldId = seedClaim();
    const chat = new FakeChat(
      recheckResponder((claimId) => ({
        claimId,
        status: "changed",
        value: "15 USD per seat per month",
        quote: VERBATIM_15,
        sourceId: "s2",
      })),
    );

    const { status, body } = await ask("has hubspot pricing changed?", chat);

    assert.equal(status, 200);
    assert.equal(body.grounded, true);
    assert.equal(body.citations.length, 2);
    assert.deepEqual(
      body.steps.map((step) => [step.action, step.status]),
      [["recheck", "done"]],
    );
    assert.equal(body.claims.inserted, 1);
    assert.equal(body.claims.superseded, 1);
    assert.equal("claimUpdates" in body, false);

    const rows = claimRows();
    assert.equal(rows[0]?.id, oldId);
    assert.equal(rows[0]?.status, "superseded");
    assert.equal(rows[1]?.value_text, "15 USD per seat per month");

    const turn = db
      .prepare("SELECT claims_status FROM turns WHERE id = ?")
      .get(body.assistantTurnId) as { claims_status: string };
    assert.equal(turn.claims_status, "done");

    // One comparison call; extraction must not run on top of it.
    assert.equal(chat.calls, 1);
  });

  it("leaves a news recheck explicitly not built", async () => {
    seedClaim();
    db.prepare("UPDATE conversations SET state_json = ? WHERE id = ?").run(
      JSON.stringify({
        ...emptyConversationState(),
        activeEntitySet: {
          id: "set-1",
          name: "crm shortlist",
          members: ["hubspot"],
        },
      }),
      conversationId,
    );

    const chat = new FakeChat();
    const { body } = await ask(
      "has any of them shipped something big since?",
      chat,
    );

    assert.deepEqual(
      body.steps.map((step) => [step.action, step.status]),
      [["recheck", "not_built"]],
    );
    assert.match(body.answer, /not built/i);
    assert.equal(search.calls, 0);
    assert.equal(chat.calls, 0);
  });
});
