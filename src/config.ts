import path from "node:path";
import { loadDotEnv } from "./env.js";

// Must run before any constant below reads process.env.
loadDotEnv();

export type ModelProvider = {
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

export type SearchProvider = {
  name: string;
  apiKey: string | null;
};

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${value ?? ""}`);
  }
  return port;
}

function parseFakeNow(value: string | undefined): string | null {
  const trimmed = text(value);
  if (trimmed === null) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid FAKE_NOW: ${trimmed}`);
  }
  return date.toISOString();
}

const mainBaseUrl =
  text(process.env.LLM_BASE_URL) ?? "https://api.groq.com/openai/v1";
const mainApiKey = text(process.env.LLM_API_KEY);
const mainModel = text(process.env.LLM_MODEL) ?? "openai/gpt-oss-20b";

/**
 * The fast call can run on a different provider than the synthesis call.
 * Free tiers differ by orders of magnitude: OpenRouter allows 50 requests a
 * day, Groq about 1,000. Unset FAST_* values inherit the main provider.
 */
const fastBaseUrl = text(process.env.FAST_BASE_URL) ?? mainBaseUrl;
const fastApiKey = text(process.env.FAST_API_KEY) ?? mainApiKey;
const fastModel = text(process.env.FAST_MODEL) ?? mainModel;

export const config = {
  port: parsePort(process.env.PORT),
  databasePath: path.resolve(
    process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "asof.db"),
  ),
  timezone: process.env.DEFAULT_TIMEZONE ?? "Asia/Kolkata",
  demoMode: process.env.DEMO_MODE === "1" || process.env.DEMO_MODE === "true",
  /**
   * One clock for the whole app. The eval harness, the demo and the reviewer
   * all need to run the same code at a different "now".
   */
  fakeNow: parseFakeNow(process.env.FAKE_NOW),
  model: {
    main: {
      baseUrl: mainBaseUrl,
      apiKey: mainApiKey,
      model: mainModel,
    } satisfies ModelProvider,
    fast: {
      baseUrl: fastBaseUrl,
      apiKey: fastApiKey,
      model: fastModel,
    } satisfies ModelProvider,
  },
  search: {
    name: text(process.env.SEARCH_PROVIDER) ?? "tavily",
    apiKey: text(process.env.TAVILY_API_KEY),
  } satisfies SearchProvider,
} as const;

/** Human-readable list of what the app cannot run without. */
export function missingKeys(): string[] {
  const missing: string[] = [];

  if (config.model.main.apiKey === null) {
    missing.push("LLM_API_KEY");
  }

  // The fast call inherits the main key unless FAST_API_KEY is set, so a
  // missing main key is the only model key that can block both calls.

  if (config.search.apiKey === null) {
    missing.push("TAVILY_API_KEY");
  }

  return missing;
}
