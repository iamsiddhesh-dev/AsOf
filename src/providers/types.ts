/**
 * The two things the answer path needs from the outside world.
 *
 * Both are interfaces so the eval can run the real pipeline against fixtures,
 * with no network and no keys. The concrete OpenAI-compatible and Tavily
 * clients live beside this file; nothing above them knows which provider is in
 * use.
 */

export type SearchResult = {
  title: string;
  url: string;
  /** ISO date when the result exposes one. Most search results do not. */
  publishedAt: string | null;
  snippet: string;
};

export type SearchResponse = {
  provider: string;
  query: string;
  results: SearchResult[];
  cached: boolean;
};

export type SearchOptions = {
  maxResults?: number;
  /** Recheck bypasses the cache; a plain search does not. */
  bypassCache?: boolean;
};

export interface SearchClient {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export type ChatUsage = {
  input: number | null;
  output: number | null;
};

export type ChatResponse = {
  content: string;
  model: string;
  latencyMs: number;
  usage: ChatUsage;
};

export interface ChatClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/**
 * One error type for both providers, carrying the HTTP status so the route can
 * tell "your key is wrong" (401) from "the provider is having a day" (503).
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;

  constructor(provider: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
  }
}
