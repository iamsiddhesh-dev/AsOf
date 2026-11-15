import { config } from "../config.js";
import type { Db } from "../db/index.js";
import { CachedSearch } from "../search/cache.js";
import { OpenAIChatClient } from "./openai.js";
import { TavilySearchClient } from "./tavily.js";
import type { ChatClient, SearchClient } from "./types.js";

/**
 * Factories, not singletons: the eval builds the same app with fixtures, and
 * tests must never be able to reach a real provider by accident.
 */
export function createChatClient(): ChatClient | null {
  const { baseUrl, apiKey } = config.model.main;
  if (apiKey === null) {
    return null;
  }
  return new OpenAIChatClient({ baseUrl, apiKey });
}

/**
 * Extraction is a fast call. It can point at a different provider than
 * synthesis, so it gets its own client rather than borrowing the main one.
 */
export function createFastChatClient(): ChatClient | null {
  const { baseUrl, apiKey } = config.model.fast;
  if (apiKey === null) {
    return null;
  }
  return new OpenAIChatClient({ baseUrl, apiKey });
}

export function createSearchClient(
  db: Db,
  clock: () => Date,
): SearchClient | null {
  if (config.search.apiKey === null || config.search.name !== "tavily") {
    return null;
  }
  return new CachedSearch(
    db,
    new TavilySearchClient({ apiKey: config.search.apiKey }),
    clock,
  );
}
