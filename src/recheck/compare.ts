import type { Db } from "../db/index.js";
import type { ChatClient, SearchClient } from "../providers/types.js";
import {
  claimContentHash,
  storeClaim,
  upsertSources,
  type ClaimSource,
} from "../claims/store.js";

export type RecheckCitation = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string;
};

export type RecheckVerdictStatus = "unchanged" | "changed" | "unknown";

export type RecheckVerdict = {
  claimId: string;
  status: RecheckVerdictStatus;
  subject: string;
  attribute: string;
  previousValue: string | null;
  value: string | null;
  sourceId: string | null;
  reason: string;
};

/**
 * A change found by a recheck. It is not written inside the answer step because
 * the assistant turn does not exist yet; the route stores it once that turn is
 * created, so the new claim still points at the answer that reported it.
 */
export type ClaimUpdate = {
  claimId: string;
  subject: string;
  attribute: string;
  claimType: string;
  value: string;
  quote: string;
  sourceRowId: string;
  unit: string | null;
  currency: string | null;
  period: string | null;
  contentHash: string;
};

export type RecheckResult = {
  text: string;
  citations: RecheckCitation[];
  grounded: boolean;
  verdicts: RecheckVerdict[];
  claimUpdates: ClaimUpdate[];
  status: "done" | "blocked";
  detail: string;
  model: string | null;
  tokenIn: number | null;
  tokenOut: number | null;
};

export type RecheckDeps = {
  search: SearchClient;
  chat: ChatClient;
  model: string;
};

export type RecheckInput = {
  text: string;
  now: Date;
  /** Names the conversation is currently talking about, if any. */
  activeEntities: string[];
  /** Citation numbering continues from earlier steps in the same answer. */
  firstIndex: number;
};

export type StoredClaim = {
  id: string;
  subject_text: string;
  attribute: string;
  claim_type: string;
  value_text: string | null;
  unit: string | null;
  currency: string | null;
  period: string | null;
  observed_at: string;
};

const MAX_CLAIMS = 3;
const MAX_SOURCES = 8;

const STOPWORDS = new Set([
  "about",
  "all",
  "an",
  "and",
  "answer",
  "any",
  "are",
  "at",
  "be",
  "been",
  "but",
  "by",
  "change",
  "changed",
  "changes",
  "check",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "recheck",
  "since",
  "still",
  "that",
  "the",
  "them",
  "these",
  "they",
  "this",
  "those",
  "to",
  "today",
  "true",
  "updates",
  "us",
  "verify",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "yes",
  "yesterday",
  "you",
  "your",
]);

const COMPARE_SYSTEM = `You compare stored claims against fresh search evidence.

Return JSON only, no prose, no code fences:
{"verdicts":[{"claimId":"...","status":"unchanged|changed|unknown","value":null,"quote":null,"sourceId":null,"reason":"..."}]}

Rules:
- Judge each stored claim only from the evidence. Use one verdict per stored claim, in the same order.
- unchanged: the evidence states the same value for the same subject, attribute, currency, and period. Include a verbatim quote and the evidence id.
- changed: the evidence states a different value for the same subject, attribute, currency, and period. Include the new value, a verbatim quote, and the evidence id.
- unknown: the evidence does not address the claim, or the claim references a period the evidence does not cover. Do not guess.
- quote must be copied verbatim from the evidence text, never paraphrased.
- A verdict without a verbatim quote cannot be trusted, so use unknown instead.`;

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function tokensOf(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].filter(
    (token) => !STOPWORDS.has(token),
  );
}

/**
 * Recheck is global, like the rest of memory. A claim is preferred when the
 * question or the active entity set names its subject; otherwise the most
 * recent active claims are what "has it changed?" can mean.
 */
export function selectClaims(
  db: Db,
  text: string,
  activeEntities: string[],
  limit = MAX_CLAIMS,
): StoredClaim[] {
  const rows = db
    .prepare(
      `SELECT id, subject_text, attribute, claim_type, value_text, unit,
              currency, period, observed_at
       FROM claims
       WHERE status = 'active'
       ORDER BY observed_at DESC, created_at DESC
       LIMIT 100`,
    )
    .all() as StoredClaim[];

  if (rows.length === 0) {
    return [];
  }

  const tokens = tokensOf(text);
  const entities = activeEntities.map((name) => name.toLowerCase());

  const scored = rows.map((row) => {
    const subject = row.subject_text.toLowerCase();
    const attribute = row.attribute.toLowerCase();
    const value = (row.value_text ?? "").toLowerCase();

    let score = 0;
    for (const token of tokens) {
      if (subject.includes(token)) {
        score += 2;
      }
      if (attribute.includes(token)) {
        score += 1;
      }
      if (value.includes(token)) {
        score += 1;
      }
    }
    for (const entity of entities) {
      if (entity.length > 1 && subject.includes(entity)) {
        score += 4;
      }
    }

    return { row, score };
  });

  const matched = scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  // "Has it changed?" has no subject, so the most recent claims are the only
  // sensible referent. A named subject must match: comparing Salesforce to a
  // HubSpot claim would answer a question the user did not ask.
  const namesSomething = tokens.length > 0 || entities.some((name) => name.length > 1);

  if (namesSomething) {
    return matched.slice(0, limit).map((entry) => entry.row);
  }

  return scored.slice(0, limit).map((entry) => entry.row);
}

function queryFor(claim: StoredClaim): string {
  const attribute = claim.attribute.replace(/[_-]+/g, " ").trim();
  return `${claim.subject_text} ${attribute}`.trim();
}

function parseVerdicts(raw: string): Array<Record<string, unknown>> {
  const cleaned = stripFences(raw);
  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match === null) {
      throw new Error("comparison returned no JSON");
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error("comparison returned unparseable JSON");
    }
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { verdicts?: unknown }).verdicts)
  ) {
    throw new Error("comparison JSON has no verdicts array");
  }

  return (parsed as { verdicts: unknown[] }).verdicts.filter(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null,
  );
}

export async function recheckClaims(
  db: Db,
  deps: RecheckDeps,
  input: RecheckInput,
): Promise<RecheckResult> {
  const empty = {
    citations: [] as RecheckCitation[],
    grounded: false,
    verdicts: [] as RecheckVerdict[],
    claimUpdates: [] as ClaimUpdate[],
    model: null,
    tokenIn: null,
    tokenOut: null,
  };

  const claims = selectClaims(db, input.text, input.activeEntities);
  if (claims.length === 0) {
    const total = (
      db
        .prepare("SELECT COUNT(*) AS count FROM claims WHERE status = 'active'")
        .get() as { count: number }
    ).count;

    return {
      ...empty,
      text:
        total === 0
          ? "I have no stored claims in the ledger to recheck. Ask the question first; once I have a cited answer, I can check whether its claims changed."
          : "I have no stored claims about that subject to recheck. I only compare claims I stored from a cited answer, so ask about that subject first.",
      status: "blocked",
      detail: total === 0 ? "no active claims" : "no stored claim matches the subject",
    };
  }

  const sources: ClaimSource[] = [];
  const seen = new Set<string>();
  const queries = [...new Set(claims.map(queryFor))];

  for (const query of queries) {
    const response = await deps.search.search(query, {
      maxResults: 5,
      bypassCache: true,
    });

    for (const result of response.results) {
      const key = `${result.url}\n${result.snippet}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      sources.push({
        id: `s${input.firstIndex + sources.length + 1}`,
        title: result.title,
        url: result.url,
        publishedAt: result.publishedAt,
        snippet: result.snippet,
      });
      if (sources.length >= MAX_SOURCES) {
        break;
      }
    }

    if (sources.length >= MAX_SOURCES) {
      break;
    }
  }

  if (sources.length === 0) {
    return {
      ...empty,
      text: "I searched again but found no usable sources, so I won't claim that nothing changed.",
      status: "blocked",
      detail: "no fresh sources",
    };
  }

  const citations: RecheckCitation[] = sources.map((source) => ({ ...source }));

  const claimLines = claims
    .map(
      (claim) =>
        `- claimId: ${claim.id}\n  subject: ${claim.subject_text}\n  attribute: ${claim.attribute}\n  value: ${claim.value_text ?? "(unknown)"}\n  currency: ${claim.currency ?? "none"}\n  period: ${claim.period ?? "none"}\n  observed at: ${claim.observed_at}`,
    )
    .join("\n");

  const evidence = sources
    .map(
      (source) =>
        `[${source.id}] ${source.title} (${source.url})\n"${source.snippet}"`,
    )
    .join("\n\n");

  const completion = await deps.chat.chat({
    model: deps.model,
    messages: [
      { role: "system", content: COMPARE_SYSTEM },
      {
        role: "user",
        content: `Stored claims:\n${claimLines}\n\nEvidence:\n${evidence}`,
      },
    ],
    maxTokens: 1_200,
    temperature: 0,
    reasoningEffort: "low",
  });

  let rows: Array<Record<string, unknown>>;
  try {
    rows = parseVerdicts(completion.content);
  } catch (error) {
    return {
      ...empty,
      citations,
      model: completion.model,
      tokenIn: completion.usage.input,
      tokenOut: completion.usage.output,
      text: `I could not compare the stored claims against the fresh sources: ${(error as Error).message}. I won't claim nothing changed.`,
      status: "blocked",
      detail: "comparison returned unusable JSON",
    };
  }

  const storedSources = upsertSources(
    db,
    sources,
    deps.search.name,
    input.now.toISOString(),
  );

  const verdicts: RecheckVerdict[] = [];
  const claimUpdates: ClaimUpdate[] = [];

  for (const claim of claims) {
    const row = rows.find((entry) => entry["claimId"] === claim.id);
    if (row === undefined) {
      verdicts.push({
        claimId: claim.id,
        status: "unknown",
        subject: claim.subject_text,
        attribute: claim.attribute,
        previousValue: claim.value_text,
        value: null,
        sourceId: null,
        reason: "the comparison returned no verdict",
      });
      continue;
    }

    const requested = row["status"];
    const status: RecheckVerdictStatus =
      requested === "unchanged" || requested === "changed" ? requested : "unknown";

    const sourceId =
      typeof row["sourceId"] === "string" ? row["sourceId"].trim() : "";
    const source = sources.find((entry) => entry.id === sourceId);
    const quote = typeof row["quote"] === "string" ? row["quote"].trim() : "";
    const value = typeof row["value"] === "string" ? row["value"].trim() : "";

    const quoteIsVerbatim =
      source !== undefined &&
      quote.length > 0 &&
      normalise(source.snippet).includes(normalise(quote));

    let finalStatus: RecheckVerdictStatus = status;
    let reason =
      typeof row["reason"] === "string" ? row["reason"].slice(0, 200) : "";

    if (status !== "unknown" && !quoteIsVerbatim) {
      finalStatus = "unknown";
      reason =
        "the model's quote did not appear verbatim in the cited evidence, so the verdict was not trusted";
    }

    if (finalStatus === "changed") {
      if (value.length === 0) {
        finalStatus = "unknown";
        reason = "the comparison said changed without a new value";
      } else if (normalise(value) === normalise(claim.value_text ?? "")) {
        finalStatus = "unchanged";
        reason = "the evidence states the same value";
      }
    }

    verdicts.push({
      claimId: claim.id,
      status: finalStatus,
      subject: claim.subject_text,
      attribute: claim.attribute,
      previousValue: claim.value_text,
      value: finalStatus === "changed" ? value : null,
      sourceId: finalStatus === "unknown" ? null : sourceId,
      reason,
    });

    if (
      finalStatus === "changed" &&
      source !== undefined &&
      quoteIsVerbatim &&
      value.length > 0
    ) {
      const sourceRowId = storedSources.get(source.id);
      if (sourceRowId !== undefined) {
        claimUpdates.push({
          claimId: claim.id,
          subject: claim.subject_text,
          attribute: claim.attribute,
          claimType: claim.claim_type,
          value,
          quote,
          sourceRowId,
          unit: claim.unit,
          currency: claim.currency,
          period: claim.period,
          contentHash: claimContentHash({
            subject: claim.subject_text,
            attribute: claim.attribute,
            value,
            sourceId: sourceRowId,
            quote,
          }),
        });
      }
    }
  }

  const lines = verdicts.map((verdict) => {
    const label = verdict.attribute.replace(/[_-]+/g, " ");

    if (verdict.status === "changed") {
      return `${verdict.subject} ${label} changed from ${verdict.previousValue ?? "the stored value"} to ${verdict.value} [${verdict.sourceId}]. I updated the ledger.`;
    }

    if (verdict.status === "unchanged") {
      return `${verdict.subject} ${label} is still ${verdict.previousValue ?? "unchanged"} [${verdict.sourceId}].`;
    }

    return `I could not confirm ${verdict.subject} ${label} from the fresh sources, so I won't claim it changed.`;
  });

  const changed = verdicts.filter((verdict) => verdict.status === "changed").length;
  const cited = verdicts.filter((verdict) => verdict.sourceId !== null).length;

  return {
    text:
      verdicts.length > 1
        ? `I checked ${verdicts.length} stored claims.\n\n${lines.join("\n")}`
        : lines.join("\n"),
    citations,
    grounded: cited > 0,
    verdicts,
    claimUpdates,
    status: "done",
    detail: `${verdicts.length} claim(s) checked, ${changed} changed`,
    model: completion.model,
    tokenIn: completion.usage.input,
    tokenOut: completion.usage.output,
  };
}

export function applyClaimUpdates(
  db: Db,
  updates: ClaimUpdate[],
  input: {
    turnId: string;
    conversationId: string;
    now: Date;
  },
): { inserted: number; superseded: number } {
  const now = input.now.toISOString();
  let inserted = 0;
  let superseded = 0;

  const transaction = db.transaction(() => {
    for (const update of updates) {
      const result = storeClaim(db, {
        turnId: input.turnId,
        conversationId: input.conversationId,
        subject: update.subject,
        attribute: update.attribute,
        claimType: update.claimType,
        value: update.value,
        unit: update.unit,
        currency: update.currency,
        period: update.period,
        confidence: 0.8,
        sourceRowId: update.sourceRowId,
        quote: update.quote,
        observedAt: now,
        contentHash: update.contentHash,
        createdAt: now,
        priorClaimId: update.claimId,
      });

      if (result.supersededId !== null) {
        superseded += 1;
      }
      inserted += 1;
    }
  });

  transaction();
  return { inserted, superseded };
}
