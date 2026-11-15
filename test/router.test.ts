import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/router/classify.js";
import { emptyConversationState } from "../src/conversations/state.js";
import type { ConversationState } from "../src/conversations/state.js";

const NOW = new Date("2026-11-15T10:00:00.000Z");
const TIMEZONE = "Asia/Kolkata";

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return { ...emptyConversationState(), ...overrides };
}

function route(
  text: string,
  options: {
    state?: ConversationState | null;
    lastAnswerAt?: string | null;
    priorClaimCount?: number;
  } = {},
) {
  return classify({
    text,
    now: NOW,
    timezone: TIMEZONE,
    state: options.state ?? null,
    lastAnswerAt: options.lastAnswerAt ?? null,
    priorClaimCount: options.priorClaimCount ?? 0,
  });
}

describe("deterministic router", () => {
  it("routes exact-date recall and resolves the day in the conversation timezone", () => {
    const asked = route("what did i ask on 3 november?");
    assert.equal(asked.intent, "recall");
    assert.equal(asked.confidence, "high");
    assert.equal(asked.requiresSearch, false);
    assert.equal(asked.timeRange?.label, "3 November 2026");

    const yesterday = route("what did i do yesterday?");
    assert.equal(yesterday.intent, "recall");
    assert.deepEqual(yesterday.timeRange, {
      start: "2026-11-13T18:30:00.000Z",
      end: "2026-11-14T18:30:00.000Z",
      label: "14 November 2026",
    });
  });

  it("routes recall without a date to the most recent turns", () => {
    const decision = route("what did you tell me about the crm shortlist?");
    assert.equal(decision.intent, "recall");
    assert.equal(decision.confidence, "medium");
    assert.equal(decision.timeRange, null);
  });

  it("asks for a date when recall mentions one it cannot resolve", () => {
    const decision = route("what did i ask on 31 february?");
    assert.equal(decision.intent, "clarify");
    assert.match(decision.clarification ?? "", /which date/i);
  });

  it("routes revalidation only when a prior answer exists", () => {
    const withClaims = route("is that still true?", { priorClaimCount: 3 });
    assert.equal(withClaims.intent, "revalidate");
    assert.equal(withClaims.requiresSearch, true);
    assert.equal(withClaims.bypassCache, true);

    const withoutClaims = route("is that still true?");
    assert.equal(withoutClaims.intent, "clarify");
    assert.match(withoutClaims.clarification ?? "", /previous answer/i);

    const answered = route("has it changed since then?", {
      state: state({ lastAnswerTurnId: "turn-1" }),
      lastAnswerAt: "2026-11-13T10:00:00.000Z",
    });
    assert.equal(answered.intent, "revalidate");
    assert.equal(answered.timeRange?.label, "since the last answer");

    const sinceDay = route("has anything changed since yesterday?", {
      priorClaimCount: 1,
    });
    assert.equal(sinceDay.intent, "revalidate");
    assert.deepEqual(sinceDay.timeRange, {
      start: "2026-11-13T18:30:00.000Z",
      end: "2026-11-15T10:00:00.000Z",
      label: "since 14 November 2026",
    });
  });

  it("treats a named revalidation as a fresh search when nothing is stored", () => {
    const decision = route("has hubspot changed its starter pricing?");
    assert.equal(decision.intent, "search");
    assert.match(decision.reason, /fresh search/);
  });

  it("asks which entities are meant when 'them' has no antecedent", () => {
    const decision = route("has any of them changed pricing?");
    assert.equal(decision.intent, "clarify");
    assert.match(decision.clarification ?? "", /which ones/i);

    const withSet = route("has any of them changed pricing?", {
      state: state({
        activeEntitySet: { id: "set-1", name: "crm shortlist", members: ["hubspot"] },
      }),
      priorClaimCount: 2,
    });
    assert.equal(withSet.intent, "revalidate");
  });

  it("defaults factual questions to search and keeps the resolved window", () => {
    const plain = route("what is hubspot starter pricing?");
    assert.equal(plain.intent, "search");
    assert.equal(plain.requiresSearch, true);
    assert.equal(plain.bypassCache, false);
    assert.equal(plain.timeRange, null);

    const windowed = route("crm pricing news in the last 7 days");
    assert.equal(windowed.intent, "search");
    assert.equal(windowed.timeRange?.label, "last 7 days");
  });

  it("splits a compound question into ordered steps", () => {
    const decision = route(
      "what did i ask on 3 november? is your answer still correct today?",
    );

    assert.deepEqual(
      decision.steps.map((step) => step.action),
      ["recall", "recheck"],
    );
    assert.equal(decision.intent, "recall");
    assert.equal(decision.requiresSearch, true);
    assert.equal(decision.bypassCache, true);
    assert.equal(decision.steps[1]?.mode, "claims");
    assert.equal(decision.clarification, null);
  });

  it("marks a recheck about launches as a news scan, not a claim diff", () => {
    const decision = route("has any of them shipped something big since?", {
      state: state({
        activeEntitySet: { id: "set-1", name: "crm shortlist", members: ["hubspot"] },
      }),
      priorClaimCount: 2,
    });

    assert.equal(decision.steps.length, 1);
    assert.equal(decision.steps[0]?.action, "recheck");
    assert.equal(decision.steps[0]?.mode, "news");
  });

  it("explains what it is blocked on when it asks a question", () => {
    assert.equal(route("is that still true?").blockedBy, "no_prior_answer");
    assert.equal(route("any of them changed?").blockedBy, "no_entity_set");
    assert.equal(route("what did i ask on 31 february?").blockedBy, "unresolved_date");
  });

  it("drops small talk that trails a real question", () => {
    const decision = route("what is hubspot starter pricing? thanks");
    assert.equal(decision.steps.length, 1);
    assert.equal(decision.intent, "search");
  });

  it("handles small talk without searching", () => {
    assert.equal(route("hello").intent, "meta");
    assert.equal(route("thanks!").intent, "meta");
    assert.equal(route("what can you do?").intent, "meta");
  });
});
