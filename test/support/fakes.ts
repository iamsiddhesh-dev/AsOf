import type {
  ChatClient,
  ChatDeltaHandler,
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

export const EMPTY_CLAIMS_REPLY = '{"claims":[]}';

/** True when the request is the claim-extraction prompt, not synthesis. */
export function isExtractionRequest(request: ChatRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === "system" &&
      message.content.includes("You extract atomic factual claims"),
  );
}

/** True when the request asks the model to compare stored claims to evidence. */
export function isRecheckRequest(request: ChatRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === "system" &&
      message.content.includes("You compare stored claims"),
  );
}

/**
 * The fixture world has one stored claim worth 20 USD and a source that says
 * the same thing, so a recheck of it is unchanged. Tests that need a change
 * pass their own responder.
 */
export function fixtureRecheckReply(request: ChatRequest): string {
  const user = request.messages.find((message) => message.role === "user");
  const claimId = /claimId: ([^\s]+)/.exec(user?.content ?? "")?.[1] ?? "";

  return JSON.stringify({
    verdicts: [
      {
        claimId,
        status: "unchanged",
        value: null,
        quote: "HubSpot Starter is 20 USD per seat per month.",
        sourceId: "s1",
        reason: "the evidence states the same value",
      },
    ],
  });
}

export type ChatResponder = (request: ChatRequest) => string;

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

  /**
   * No argument answers synthesis with DEFAULT_REPLY and extraction with an
   * empty claim list. An explicit string or responder takes full control, which
   * the claim tests need.
   */
  constructor(private readonly reply: string | ChatResponder | null = null) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    this.requests.push(request);

    const content =
      this.reply === null
        ? isRecheckRequest(request)
          ? fixtureRecheckReply(request)
          : isExtractionRequest(request)
            ? EMPTY_CLAIMS_REPLY
            : DEFAULT_REPLY
        : typeof this.reply === "function"
          ? this.reply(request)
          : this.reply;

    return {
      content,
      model: request.model,
      latencyMs: 0,
      usage: { input: 100, output: 20 },
    };
  }

  /**
   * The same fixture reply, delivered in word-sized deltas. It is not a real
   * tokenizer, but it proves the caller forwards chunks in order and that the
   * assembled text matches the non-streaming answer.
   */
  async stream(
    request: ChatRequest,
    onDelta: ChatDeltaHandler,
  ): Promise<ChatResponse> {
    const response = await this.chat(request);

    for (const piece of response.content.match(/\S+\s*/g) ?? []) {
      await onDelta(piece);
    }

    return response;
  }
}
