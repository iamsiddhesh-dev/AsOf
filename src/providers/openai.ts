import {
  ProviderError,
  type ChatClient,
  type ChatRequest,
  type ChatResponse,
} from "./types.js";

type ChatBody = {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};

export type OpenAIChatOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Extra attempts after the first. Two means three requests at most. */
  retries?: number;
  retryBaseMs?: number;
  defaultTimeoutMs?: number;
};

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number, baseMs: number): number {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, 10_000);
    }
  }
  return Math.min(baseMs * 2 ** attempt, 4_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * OpenAI-compatible chat client, which covers Groq, OpenRouter, and Google's
 * compatibility endpoint. The retry policy is deliberately small: one answer
 * per turn should not turn into a retry storm that eats a free-tier budget.
 */
export class OpenAIChatClient implements ChatClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: OpenAIChatOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = options.retries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };

    if (hostOf(this.baseUrl).endsWith("openrouter.ai")) {
      headers["http-referer"] = "https://github.com/iamsiddhesh-dev/AsOf";
      headers["x-title"] = "AsOf";
    }

    return headers;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const started = Date.now();
      let response: Response;

      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            max_tokens: request.maxTokens ?? 800,
            temperature: request.temperature ?? 0,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = new ProviderError(
          "model",
          `request timed out or failed: ${(error as Error).message}`,
        );
        if (attempt < this.retries) {
          await sleep(this.retryBaseMs * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      const raw = await response.text();

      if (!response.ok) {
        lastError = new ProviderError(
          "model",
          `http ${response.status}: ${raw.slice(0, 200)}`,
          response.status,
        );
        if (retryable(response.status) && attempt < this.retries) {
          await sleep(retryDelayMs(response, attempt, this.retryBaseMs));
          continue;
        }
        throw lastError;
      }

      let body: ChatBody;
      try {
        body = JSON.parse(raw) as ChatBody;
      } catch {
        throw new ProviderError("model", "response was not JSON", response.status);
      }

      const content = body.choices?.[0]?.message?.content?.trim() ?? "";
      if (content.length === 0) {
        const finish = body.choices?.[0]?.finish_reason ?? "unknown";
        throw new ProviderError(
          "model",
          `empty completion (finish_reason: ${finish})`,
          response.status,
        );
      }

      return {
        content,
        model: body.model ?? request.model,
        latencyMs: Date.now() - started,
        usage: {
          input: body.usage?.prompt_tokens ?? null,
          output: body.usage?.completion_tokens ?? null,
        },
      };
    }

    throw lastError ?? new ProviderError("model", "request failed");
  }
}
