import type { Db } from "../db/index.js";
import type { ChatClient } from "../providers/types.js";
import {
  claimContentHash,
  storeClaim,
  upsertSources,
  type ClaimSource,
} from "./store.js";

export type { ClaimSource } from "./store.js";

export type ExtractedClaim = {
  subject: string;
  attribute: string;
  value: string;
  quote: string;
  sourceId: string | null;
  unit: string | null;
  currency: string | null;
  period: string | null;
};

export type ClaimExtractionResult = {
  inserted: number;
  superseded: number;
  dropped: number;
  reason: string | null;
};

export type ClaimExtractionInput = {
  answer: string;
  sources: ClaimSource[];
  turnId: string;
  conversationId: string;
  now: Date;
  provider: string;
};

export type ClaimExtractionDeps = {
  chat: ChatClient;
  model: string;
};

const MAX_CLAIMS = 8;

const EXTRACT_SYSTEM = `You extract atomic factual claims from an answer and the evidence it used.

Return JSON only, no prose, no code fences:
{"claims":[{"subject":"...","attribute":"...","value":"...","quote":"...","sourceId":"s1","unit":null,"currency":null,"period":null}]}

Rules:
- Only claims stated in the answer and directly supported by the evidence.
- quote must be copied verbatim from the evidence text, never paraphrased.
- subject is the product, company, or thing being described.
- attribute is the measured property, such as price, free_tier_limit, release_date, availability.
- sourceId must be one of the ids you were given.
- unit, currency, and period are short strings or null.
- An empty array is a valid answer: {"claims":[]}.
- At most ${MAX_CLAIMS} claims.`;

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parseClaims(raw: string): ExtractedClaim[] {
  const cleaned = stripFences(raw);
  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match === null) {
      throw new Error("extraction returned no JSON");
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error("extraction returned unparseable JSON");
    }
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { claims?: unknown }).claims)
  ) {
    throw new Error("extraction JSON has no claims array");
  }

  const rows = (parsed as { claims: unknown[] }).claims;
  const claims: ExtractedClaim[] = [];

  for (const row of rows.slice(0, MAX_CLAIMS)) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const value = row as Record<string, unknown>;
    const subject = typeof value["subject"] === "string" ? value["subject"].trim() : "";
    const attribute =
      typeof value["attribute"] === "string" ? value["attribute"].trim() : "";
    const claimValue =
      typeof value["value"] === "string" ? value["value"].trim() : "";
    const quote = typeof value["quote"] === "string" ? value["quote"].trim() : "";
    const sourceId =
      typeof value["sourceId"] === "string" && value["sourceId"].trim().length > 0
        ? value["sourceId"].trim()
        : null;

    if (
      subject.length === 0 ||
      attribute.length === 0 ||
      claimValue.length === 0 ||
      quote.length === 0
    ) {
      continue;
    }

    claims.push({
      subject: subject.slice(0, 120),
      attribute: attribute.slice(0, 60),
      value: claimValue.slice(0, 200),
      quote: quote.slice(0, 400),
      sourceId,
      unit: typeof value["unit"] === "string" ? value["unit"].slice(0, 40) : null,
      currency:
        typeof value["currency"] === "string" ? value["currency"].slice(0, 8) : null,
      period: typeof value["period"] === "string" ? value["period"].slice(0, 20) : null,
    });
  }

  return claims;
}

function claimType(claim: ExtractedClaim): string {
  return claim.currency === null ? "fact" : "price";
}

/**
 * Claims are only kept when the quote can be found verbatim in the cited
 * evidence. A model that paraphrases the source, or invents a number, produces
 * a claim the ledger refuses to store. That check is the point of the slice:
 * downstream recheck is only as trustworthy as what got written here.
 */
function keepClaim(claim: ExtractedClaim, sources: ClaimSource[]): boolean {
  if (claim.sourceId === null) {
    return false;
  }

  const source = sources.find((entry) => entry.id === claim.sourceId);
  if (source === undefined) {
    return false;
  }

  return normalise(source.snippet).includes(normalise(claim.quote));
}

function persist(
  db: Db,
  input: ClaimExtractionInput,
  claims: ExtractedClaim[],
): { inserted: number; superseded: number } {
  const now = input.now.toISOString();
  let inserted = 0;
  let superseded = 0;

  const findDuplicate = db.prepare(
    "SELECT 1 AS hit FROM claims WHERE turn_id = ? AND content_hash = ?",
  );

  const transaction = db.transaction(() => {
    const stored = upsertSources(db, input.sources, input.provider, now);

    for (const claim of claims) {
      const sourceRowId =
        claim.sourceId === null ? null : stored.get(claim.sourceId) ?? null;

      const hash = claimContentHash({
        subject: claim.subject,
        attribute: claim.attribute,
        value: claim.value,
        sourceId: sourceRowId,
        quote: claim.quote,
      });

      if (findDuplicate.get(input.turnId, hash) !== undefined) {
        continue;
      }

      const result = storeClaim(db, {
        turnId: input.turnId,
        conversationId: input.conversationId,
        subject: claim.subject,
        attribute: claim.attribute,
        claimType: claimType(claim),
        value: claim.value,
        unit: claim.unit,
        currency: claim.currency,
        period: claim.period,
        confidence: 0.8,
        sourceRowId,
        quote: claim.quote,
        observedAt: now,
        contentHash: hash,
        createdAt: now,
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

export async function extractClaims(
  db: Db,
  deps: ClaimExtractionDeps,
  input: ClaimExtractionInput,
): Promise<ClaimExtractionResult> {
  if (input.sources.length === 0 || input.answer.trim().length === 0) {
    return { inserted: 0, superseded: 0, dropped: 0, reason: "nothing to extract" };
  }

  const evidence = input.sources
    .map(
      (source) =>
        `[${source.id}] ${source.title} (${source.url})\n"${source.snippet}"`,
    )
    .join("\n\n");

  const completion = await deps.chat.chat({
    model: deps.model,
    messages: [
      { role: "system", content: EXTRACT_SYSTEM },
      {
        role: "user",
        content: `Answer:\n${input.answer}\n\nEvidence:\n${evidence}`,
      },
    ],
    maxTokens: 1_200,
    temperature: 0,
    reasoningEffort: "low",
  });

  const parsed = parseClaims(completion.content);
  const valid = parsed.filter((claim) => keepClaim(claim, input.sources));
  const result = persist(db, input, valid);

  return {
    ...result,
    dropped: parsed.length - valid.length,
    reason: null,
  };
}
