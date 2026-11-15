import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";

export type ClaimSource = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string;
};

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * A source row is keyed by what was fetched, not by the answer that cited it.
 * Two answers quoting the same snippet from the same page share one row.
 */
export function sourceRowId(
  provider: string,
  canonical: string,
  snippet: string,
): string {
  const hash = createHash("sha256")
    .update(`${provider}\n${canonical}\n${snippet}`)
    .digest("hex")
    .slice(0, 24);
  return `src-${hash}`;
}

/**
 * Writes the fetched pages and returns a map from the prompt's `s1` ids to the
 * `sources.id` values claims can reference.
 */
export function upsertSources(
  db: Db,
  sources: ClaimSource[],
  provider: string,
  now: string,
): Map<string, string> {
  const insert = db.prepare(
    `INSERT INTO sources
      (id, url, canonical_url, domain, title, published_at, fetched_at,
       snippet, provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       fetched_at = excluded.fetched_at,
       title = excluded.title,
       snippet = excluded.snippet`,
  );

  const stored = new Map<string, string>();

  for (const source of sources) {
    const canonical = canonicalUrl(source.url);
    let domain = canonical;
    try {
      domain = new URL(canonical).hostname.replace(/^www\./, "");
    } catch {
      // keep the raw string; the column is display-only
    }

    const id = sourceRowId(provider, canonical, source.snippet);
    insert.run(
      id,
      source.url,
      canonical,
      domain,
      source.title,
      source.publishedAt,
      now,
      source.snippet,
      provider,
    );
    stored.set(source.id, id);
  }

  return stored;
}

export type StoreClaimInput = {
  turnId: string;
  conversationId: string;
  subject: string;
  attribute: string;
  claimType: string;
  value: string;
  unit: string | null;
  currency: string | null;
  period: string | null;
  confidence: number;
  /** `sources.id`, or null when the claim has no usable quote. */
  sourceRowId: string | null;
  quote: string;
  observedAt: string;
  contentHash: string;
  createdAt: string;
  /**
   * undefined — look up an active claim with the same identity and supersede it
   * null      — never supersede anything
   * string    — supersede exactly this claim, e.g. the one a recheck compared
   */
  priorClaimId?: string | null;
};

function findActiveByIdentity(
  db: Db,
  subject: string,
  attribute: string,
  currency: string | null,
  period: string | null,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM claims
       WHERE lower(subject_text) = lower(?)
         AND lower(attribute) = lower(?)
         AND currency IS ?
         AND period IS ?
         AND status = 'active'
       ORDER BY observed_at DESC, created_at DESC
       LIMIT 1`,
    )
    .get(subject, attribute, currency, period) as { id: string } | undefined;

  return row?.id ?? null;
}

/**
 * Claims are append-only. A new claim supersedes the old one instead of
 * overwriting it, so "what did the ledger believe on 14 November" stays
 * answerable after a recheck changes the value.
 */
export function storeClaim(
  db: Db,
  input: StoreClaimInput,
): { id: string; supersededId: string | null } {
  let priorId: string | null = null;

  if (input.priorClaimId === undefined) {
    priorId = findActiveByIdentity(
      db,
      input.subject,
      input.attribute,
      input.currency,
      input.period,
    );
  } else if (typeof input.priorClaimId === "string") {
    priorId = input.priorClaimId;
  }

  if (priorId !== null) {
    db.prepare(
      "UPDATE claims SET status = 'superseded' WHERE id = ? AND status = 'active'",
    ).run(priorId);
  }

  const id = randomUUID();

  db.prepare(
    `INSERT INTO claims
      (id, turn_id, conversation_id, subject_text, attribute, claim_type,
       value_json, value_text, unit, currency, period, confidence, source_kind,
       source_id, quote, observed_at, supersedes_claim_id, status,
       content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    input.turnId,
    input.conversationId,
    input.subject,
    input.attribute,
    input.claimType,
    JSON.stringify({ text: input.value }),
    input.value,
    input.unit,
    input.currency,
    input.period,
    input.confidence,
    input.sourceRowId,
    input.quote,
    input.observedAt,
    priorId,
    input.contentHash,
    input.createdAt,
  );

  return { id, supersededId: priorId };
}

export function claimContentHash(parts: {
  subject: string;
  attribute: string;
  value: string;
  sourceId: string | null;
  quote: string;
}): string {
  return createHash("sha256")
    .update(
      [
        parts.subject.replace(/\s+/g, " ").trim().toLowerCase(),
        parts.attribute.replace(/\s+/g, " ").trim().toLowerCase(),
        parts.value.replace(/\s+/g, " ").trim().toLowerCase(),
        parts.sourceId ?? "",
        parts.quote.replace(/\s+/g, " ").trim().toLowerCase(),
      ].join("\n"),
    )
    .digest("hex");
}
