import {
  ProviderError,
  type SearchClient,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
} from "./types.js";

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
};

type TavilyBody = {
  results?: TavilyResult[];
};

export type TavilyOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  maxSnippetChars?: number;
};

function dateOnly(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match === null ? null : match[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tavily returns page extracts, not raw HTML, which is what a synthesis prompt
 * needs: enough text to quote, short enough to fit five of them in a prompt.
 */
export class TavilySearchClient implements SearchClient {
  readonly name = "tavily";

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxSnippetChars: number;

  constructor(options: TavilyOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? "https://api.tavily.com/search";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxSnippetChars = options.maxSnippetChars ?? 700;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const maxResults = options.maxResults ?? 5;
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;

      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            query,
            search_depth: "basic",
            max_results: maxResults,
            include_answer: false,
            include_raw_content: false,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = new ProviderError(
          "search",
          `request timed out or failed: ${(error as Error).message}`,
        );
        if (attempt === 0) {
          await sleep(500);
          continue;
        }
        throw lastError;
      }

      const raw = await response.text();

      if (!response.ok) {
        lastError = new ProviderError(
          "search",
          `http ${response.status}: ${raw.slice(0, 200)}`,
          response.status,
        );
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt === 0) {
          await sleep(1_000);
          continue;
        }
        throw lastError;
      }

      let body: TavilyBody;
      try {
        body = JSON.parse(raw) as TavilyBody;
      } catch {
        throw new ProviderError("search", "response was not JSON", response.status);
      }

      const results: SearchResult[] = [];

      for (const row of body.results ?? []) {
        const title = row.title?.trim() ?? "";
        const url = row.url?.trim() ?? "";
        if (title.length === 0 || url.length === 0) {
          continue;
        }
        results.push({
          title,
          url,
          publishedAt: dateOnly(row.published_date),
          snippet: (row.content ?? "").trim().slice(0, this.maxSnippetChars),
        });
      }

      return { provider: this.name, query, results, cached: false };
    }

    throw lastError ?? new ProviderError("search", "request failed");
  }
}
