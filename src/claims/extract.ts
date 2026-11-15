import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import type { ChatClient } from "../providers/types.js";

export type ClaimSource = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string;
};

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

function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function sourceId(provider: string, canonical: string, snippet: string): string {
  const hash = createHash("sha256")
    .update(`${provider}\n${canonical}\n${snippet}`)
    .digest("hex")
    .slice(0, 24);
  return `src-${hash}`;
}

function claimType(claim: ExtractedClaim): string {
  return claim.currency === null ? "fact" : "price";
}

function claimHash(claim: ExtractedClaim): string {
  return createHash("sha256")
    .update(
      [
        normalise(claim.subject),
        normalise(claim.attribute),
        normalise(claim.value),
        claim.sourceId ?? "",
        normalise(claim.quote),
      ].join("\n"),
    )
    .digest("hex");
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

  const insertSource = db.prepare(
    `INSERT INTO sources
      (id, url, canonical_url, domain, title, published_at, fetched_at,
       snippet, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       fetched_at = excluded.fetched_at,
       title = excluded.title,
       snippet = excluded.snippet`,
  );

  const findPrior = db.prepare(
    `SELECT id FROM claims
     WHERE lower(subject_text) = lower(?)
       AND lower(attribute) = lower(?)
       AND period IS ?
       AND currency IS ?
       AND status = 'active'
     ORDER BY observed_at DESC, created_at DESC
     LIMIT 1`,
  );

  const findDuplicate = db.prepare(
    "SELECT 1 AS hit FROM claims WHERE turn_id = ? AND content_hash = ?",
  );

  const supersede = db.prepare(
    "UPDATE claims SET status = 'superseded' WHERE id = ?",
  );

  const insertClaim = db.prepare(
    `INSERT INTO claims
      (id, turn_id, conversation_id, subject_text, attribute, claim_type,
       value_json, value_text, unit, currency, period, confidence, source_kind,
       source_id, quote, observed_at, supersedes_claim_id, status,
       content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, 'active', ?, ?)`,
  );

  const transaction = db.transaction(() => {
    const stored = new Map<string, string>();

    for (const source of input.sources) {
      const canonical = canonicalUrl(source.url);
      let domain = canonical;
      try {
        domain = new URL(canonical).hostname.replace(/^www\./, "");
      } catch {
        // keep the raw string; the column is display-only
      }

      const id = sourceId(input.provider, canonical, source.snippet);
      insertSource.run(
        id,
        source.url,
        canonical,
        domain,
        source.title,
        source.publishedAt,
        now,
        source.snippet,
        input.provider,
      );
      stored.set(source.id, id);
    }

    for (const claim of claims) {
      const hash = claimHash(claim);
      if (findDuplicate.get(input.turnId, hash) !== undefined) {
        continue;
      }

      const prior = findPrior.get(
        claim.subject,
        claim.attribute,
        claim.period,
        claim.currency,
      ) as { id: string } | undefined;

      if (prior !== undefined) {
        supersede.run(prior.id);
        superseded += 1;
      }

      insertClaim.run(
        randomUUID(),
        input.turnId,
        input.conversationId,
        claim.subject,
        claim.attribute,
        claimType(claim),
        JSON.stringify({ text: claim.value }),
        claim.value,
        claim.unit,
        claim.currency,
        claim.period,
        0.8,
        claim.sourceId === null ? null : stored.get(claim.sourceId) ?? null,
        claim.quote,
        now,
        prior?.id ?? null,
        hash,
        now,
      );
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
