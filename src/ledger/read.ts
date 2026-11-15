import type { Db } from "../db/index.js";
import type { ClaimStatus } from "./claims.js";

export type ClaimSourceView = {
  id: string;
  title: string | null;
  url: string;
  domain: string;
  publishedAt: string | null;
  fetchedAt: string;
};

export type ClaimView = {
  id: string;
  subject: string;
  attribute: string;
  claimType: string;
  value: string | null;
  unit: string | null;
  currency: string | null;
  period: string | null;
  status: ClaimStatus;
  confidence: number;
  observedAt: string;
  createdAt: string;
  quote: string;
  supersedesClaimId: string | null;
  turnId: string;
  conversationId: string;
  conversationTitle: string | null;
  source: ClaimSourceView | null;
};

type ClaimRow = {
  id: string;
  subject_text: string;
  attribute: string;
  claim_type: string;
  value_text: string | null;
  unit: string | null;
  currency: string | null;
  period: string | null;
  status: ClaimStatus;
  confidence: number;
  observed_at: string;
  created_at: string;
  quote: string;
  supersedes_claim_id: string | null;
  turn_id: string;
  conversation_id: string;
  conversation_title: string | null;
  source_id: string | null;
  source_title: string | null;
  source_url: string | null;
  source_domain: string | null;
  source_published_at: string | null;
  source_fetched_at: string | null;
};

const SELECT_CLAIMS = `
  SELECT c.id, c.subject_text, c.attribute, c.claim_type, c.value_text,
         c.unit, c.currency, c.period, c.status, c.confidence,
         c.observed_at, c.created_at, c.quote, c.supersedes_claim_id,
         c.turn_id, c.conversation_id,
         conv.title AS conversation_title,
         s.id AS source_id, s.title AS source_title, s.url AS source_url,
         s.domain AS source_domain, s.published_at AS source_published_at,
         s.fetched_at AS source_fetched_at
  FROM claims c
  JOIN conversations conv ON conv.id = c.conversation_id
  LEFT JOIN sources s ON s.id = c.source_id
`;

function mapClaim(row: ClaimRow): ClaimView {
  return {
    id: row.id,
    subject: row.subject_text,
    attribute: row.attribute,
    claimType: row.claim_type,
    value: row.value_text,
    unit: row.unit,
    currency: row.currency,
    period: row.period,
    status: row.status,
    confidence: row.confidence,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    quote: row.quote,
    supersedesClaimId: row.supersedes_claim_id,
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    source:
      row.source_id === null || row.source_url === null
        ? null
        : {
            id: row.source_id,
            title: row.source_title,
            url: row.source_url,
            domain: row.source_domain ?? row.source_url,
            publishedAt: row.source_published_at,
            fetchedAt: row.source_fetched_at ?? row.created_at,
          },
  };
}

export type ClaimStatusFilter = ClaimStatus | "all";

export type ListClaimsOptions = {
  status?: ClaimStatusFilter;
  /** Substring match on the subject, case-insensitive. */
  subject?: string | null;
  /** Substring match on subject, attribute, or value. */
  query?: string | null;
  limit?: number;
  offset?: number;
};

export type ClaimPage = {
  claims: ClaimView[];
  total: number;
  limit: number;
  offset: number;
};

/**
 * The ledger view, read directly: claims are the objects, not a by-product of
 * an answer. Defaults to active claims, because that is what the ledger
 * currently stands behind.
 */
export function listClaims(db: Db, options: ListClaimsOptions = {}): ClaimPage {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const where: string[] = [];
  const params: unknown[] = [];

  const status = options.status ?? "active";
  if (status !== "all") {
    where.push("c.status = ?");
    params.push(status);
  }

  const subject = options.subject?.trim() ?? "";
  if (subject.length > 0) {
    where.push("lower(c.subject_text) LIKE lower(?)");
    params.push(`%${subject}%`);
  }

  const query = options.query?.trim() ?? "";
  if (query.length > 0) {
    where.push(
      "(lower(c.subject_text) LIKE lower(?) OR lower(c.attribute) LIKE lower(?) OR lower(c.value_text) LIKE lower(?))",
    );
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }

  const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS count FROM claims c ${clause}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(
      `${SELECT_CLAIMS} ${clause}
       ORDER BY c.observed_at DESC, c.created_at DESC, c.rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ClaimRow[];

  return {
    claims: rows.map(mapClaim),
    total: totalRow.count,
    limit,
    offset,
  };
}

export function getClaim(db: Db, id: string): ClaimView | null {
  const row = db
    .prepare(`${SELECT_CLAIMS} WHERE c.id = ?`)
    .get(id) as ClaimRow | undefined;
  return row === undefined ? null : mapClaim(row);
}

export type SubjectSummary = {
  subject: string;
  active: number;
  superseded: number;
  lastObservedAt: string;
};

/** The ledger's index: which subjects it holds, and how much of each. */
export function listSubjects(db: Db, limit = 100): SubjectSummary[] {
  const rows = db
    .prepare(
      `SELECT subject_text AS subject,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded,
              MAX(observed_at) AS last_observed_at
       FROM claims
       GROUP BY lower(subject_text)
       ORDER BY last_observed_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    subject: string;
    active: number;
    superseded: number;
    last_observed_at: string;
  }>;

  return rows.map((row) => ({
    subject: row.subject,
    active: row.active,
    superseded: row.superseded,
    lastObservedAt: row.last_observed_at,
  }));
}

/**
 * The connected supersession chain a claim belongs to, oldest first.
 *
 * The chain is walked through `supersedes_claim_id` rather than by matching
 * subject text: two separate price histories for the same product must not be
 * stitched into one timeline.
 */
export function claimHistory(db: Db, id: string): ClaimView[] {
  const target = getClaim(db, id);
  if (target === null) {
    return [];
  }

  const rows = db
    .prepare(
      `${SELECT_CLAIMS}
       WHERE lower(c.subject_text) = lower(?)
         AND lower(c.attribute) = lower(?)
         AND c.currency IS ?
         AND c.period IS ?
       ORDER BY c.rowid ASC`,
    )
    .all(
      target.subject,
      target.attribute,
      target.currency,
      target.period,
    ) as ClaimRow[];

  const claims = rows.map(mapClaim);
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const seen = new Set<string>([target.id]);
  const queue = [target.id];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === undefined) {
      break;
    }

    const current = byId.get(currentId);
    if (current === undefined) {
      continue;
    }

    if (current.supersedesClaimId !== null && !seen.has(current.supersedesClaimId)) {
      if (byId.has(current.supersedesClaimId)) {
        seen.add(current.supersedesClaimId);
        queue.push(current.supersedesClaimId);
      }
    }

    for (const claim of claims) {
      if (claim.supersedesClaimId === currentId && !seen.has(claim.id)) {
        seen.add(claim.id);
        queue.push(claim.id);
      }
    }
  }

  return claims
    .filter((claim) => seen.has(claim.id))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
}
