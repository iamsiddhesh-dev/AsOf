import { createHash } from "node:crypto";
import type { Db } from "../db/index.js";
import type {
  SearchClient,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "../providers/types.js";

type CacheRow = {
  results_json: string;
  expires_at: string;
};

export function searchCacheKey(
  provider: string,
  query: string,
  maxResults: number,
): string {
  return createHash("sha256")
    .update(`${provider}\n${query.trim().toLowerCase()}\n${maxResults}`)
    .digest("hex");
}

function parseResults(raw: string): SearchResult[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(value) ? (value as SearchResult[]) : null;
}

/**
 * The `search_cache` table already exists in the ledger because a search is a
 * fetched source, not a transient side effect. Caching keeps the free-tier
 * budget for questions that actually changed, and gives recheck its "bypass
 * the cache" semantics.
 */
export class CachedSearch implements SearchClient {
  readonly name: string;

  private readonly db: Db;
  private readonly inner: SearchClient;
  private readonly clock: () => Date;
  private readonly ttlMs: number;

  constructor(
    db: Db,
    inner: SearchClient,
    clock: () => Date,
    ttlMs = 15 * 60 * 1_000,
  ) {
    this.db = db;
    this.inner = inner;
    this.clock = clock;
    this.name = inner.name;
    this.ttlMs = ttlMs;
  }

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResponse> {
    const maxResults = options.maxResults ?? 5;
    const now = this.clock();
    const key = searchCacheKey(this.name, query, maxResults);

    if (options.bypassCache !== true) {
      const row = this.db
        .prepare("SELECT results_json, expires_at FROM search_cache WHERE key = ?")
        .get(key) as CacheRow | undefined;

      if (row !== undefined && row.expires_at > now.toISOString()) {
        const results = parseResults(row.results_json);
        if (results !== null) {
          return { provider: this.name, query, results, cached: true };
        }
      }
    }

    const fresh = await this.inner.search(query, { maxResults });
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

    this.db
      .prepare(
        `INSERT INTO search_cache
          (key, provider, query, fetched_at, expires_at, results_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           results_json = excluded.results_json`,
      )
      .run(
        key,
        this.name,
        query,
        now.toISOString(),
        expiresAt,
        JSON.stringify(fresh.results),
      );

    return { ...fresh, cached: false };
  }
}
