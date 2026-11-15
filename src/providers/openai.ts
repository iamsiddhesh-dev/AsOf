import {
  ProviderError,
  type ChatClient,
  type ChatDeltaHandler,
  type ChatRequest,
  type ChatResponse,
  type ChatUsage,
} from "./types.js";

type ChatBody = {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
};

type StreamBody = ChatBody;

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
 * The payload of one `data:` frame, or null when the frame has no data line.
 * SSE allows several `data:` lines per event, joined with newlines.
 */
function sseData(frame: string): string | null {
  const data: string[] = [];

  for (const raw of frame.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith("data:")) {
      continue;
    }
    data.push(line.slice(5).replace(/^ /, ""));
  }

  return data.length === 0 ? null : data.join("\n");
}

/**
 * Yields the data payload of every SSE frame in a response body.
 *
 * Exported because the framing rules are worth testing on their own: a frame
 * can arrive split across two network reads, and a provider may interleave
 * comment keep-alives that carry no `data:` line at all.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = sseData(frame);
        if (data !== null) {
          yield data;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    const trailing = sseData(buffer);
    if (trailing !== null) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
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

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 800,
      temperature: request.temperature ?? 0,
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: request.reasoningEffort }),
      ...(stream
        ? {
            stream: true,
            // Without this, Groq and OpenAI omit usage from a streamed
            // response, and a streamed turn would look cheaper than it was.
            stream_options: { include_usage: true },
          }
        : {}),
    };
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
          body: JSON.stringify(this.body(request, false)),
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

  /**
   * Streams a completion. Retries are only possible before the first token:
   * once a delta has been handed to the caller, a second attempt would repeat
   * text the user has already seen, so the stream fails instead.
   */
  async stream(
    request: ChatRequest,
    onDelta: ChatDeltaHandler,
  ): Promise<ChatResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const timeoutMs = request.timeoutMs ?? Math.max(this.defaultTimeoutMs, 60_000);
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const started = Date.now();
      let response: Response;

      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(this.body(request, true)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = new ProviderError(
          "model",
          `stream request timed out or failed: ${(error as Error).message}`,
        );
        if (attempt < this.retries) {
          await sleep(this.retryBaseMs * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const raw = await response.text();
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

      if (response.body === null) {
        throw new ProviderError("model", "stream had no body", response.status);
      }

      let content = "";
      let model = request.model;
      let usage: ChatUsage = { input: null, output: null };

      try {
        for await (const data of readSseData(response.body)) {
          if (data === "[DONE]") {
            break;
          }

          let chunk: StreamBody;
          try {
            chunk = JSON.parse(data) as StreamBody;
          } catch {
            // A keep-alive or a provider-specific frame; not a token.
            continue;
          }

          if (typeof chunk.model === "string" && chunk.model.length > 0) {
            model = chunk.model;
          }

          if (chunk.usage != null) {
            usage = {
              input: chunk.usage.prompt_tokens ?? null,
              output: chunk.usage.completion_tokens ?? null,
            };
          }

          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            content += delta;
            await onDelta(delta);
          }
        }
      } catch (error) {
        if (error instanceof ProviderError) {
          throw error;
        }
        throw new ProviderError(
          "model",
          `stream broke after ${content.length} characters: ${(error as Error).message}`,
          response.status,
        );
      }

      const trimmed = content.trim();
      if (trimmed.length === 0) {
        throw new ProviderError(
          "model",
          "empty completion (stream produced no tokens)",
          response.status,
        );
      }

      return {
        content: trimmed,
        model,
        latencyMs: Date.now() - started,
        usage,
      };
    }

    throw lastError ?? new ProviderError("model", "stream request failed");
  }
}
