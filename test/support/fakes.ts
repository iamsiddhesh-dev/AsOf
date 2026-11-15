import type {
  ChatClient,
  ChatRequest,
  ChatResponse,
  SearchClient,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "../../src/providers/types.js";

/**
 * Fixtures shared by the unit tests and the eval.
 *
 * The fake model always cites [s1] and [s2], so the answer-path tests measure
 * plumbing and citation validation, not a model's mood. `probe:models` is the
 * tool that measures a real model.
 */
export const FIXTURE_SOURCES: SearchResult[] = [
  {
    title: "HubSpot pricing",
    url: "https://www.hubspot.com/pricing",
    publishedAt: "2026-11-12",
    snippet: "HubSpot Starter is 20 USD per seat per month.",
  },
  {
    title: "CRM pricing roundup",
    url: "https://crmblog.example/hubspot",
    publishedAt: "2025-03-04",
    snippet: "HubSpot Starter costs 15 USD per seat per month.",
  },
];

export const DEFAULT_REPLY =
  "HubSpot Starter is 20 USD per seat per month [s1]. An earlier source listed 15 USD [s2], so the price has increased.";

export class FakeSearch implements SearchClient {
  readonly name = "fake";
  calls = 0;
  readonly queries: string[] = [];

  constructor(private readonly results: SearchResult[] = FIXTURE_SOURCES) {}

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResponse> {
    this.calls += 1;
    this.queries.push(query);
    const maxResults = options.maxResults ?? 5;
    return {
      provider: this.name,
      query,
      results: this.results.slice(0, maxResults),
      cached: false,
    };
  }
}

export class FakeChat implements ChatClient {
  calls = 0;
  readonly requests: ChatRequest[] = [];

  constructor(private readonly reply: string = DEFAULT_REPLY) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    this.requests.push(request);
    return {
      content: this.reply,
      model: request.model,
      latencyMs: 0,
      usage: { input: 100, output: 20 },
    };
  }
}
