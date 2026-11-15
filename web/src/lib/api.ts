import type {
  AnswerBlock,
  AskResponse,
  Citation,
  Claim,
  ClaimPage,
  ClaimStatus,
  Conversation,
  DemoState,
  RouteDecision,
  Stats,
  StepEvent,
  StreamError,
  SubjectSummary,
  Turn,
} from "./types.js";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The conversation's clock is the browser's unless the user says otherwise. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();

  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `request failed (${response.status})`;
    throw new ApiError(message, response.status, body);
  }

  return body as T;
}

function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-timezone": browserTimezone(),
  };
}

export const api = {
  stats(): Promise<Stats> {
    return request<Stats>("/api/ledger/stats");
  },

  health(): Promise<{ ok: boolean; time: string }> {
    return request<{ ok: boolean; time: string }>("/health");
  },

  listConversations(): Promise<{ conversations: Conversation[] }> {
    return request<{ conversations: Conversation[] }>("/api/conversations");
  },

  getConversation(id: string): Promise<Conversation> {
    return request<Conversation>(`/api/conversations/${id}`);
  },

  createConversation(title?: string): Promise<Conversation> {
    return request<Conversation>("/api/conversations", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ title, timezone: browserTimezone() }),
    });
  },

  listTurns(id: string): Promise<{ turns: Turn[] }> {
    return request<{ turns: Turn[] }>(`/api/conversations/${id}/turns?limit=200`);
  },

  listClaims(
    params: {
      status?: ClaimStatus | "all";
      subject?: string | null;
      q?: string | null;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ClaimPage> {
    const search = new URLSearchParams();
    if (params.status !== undefined) search.set("status", params.status);
    if (params.subject !== undefined && params.subject !== null && params.subject !== "") {
      search.set("subject", params.subject);
    }
    if (params.q !== undefined && params.q !== null && params.q !== "") {
      search.set("q", params.q);
    }
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    const query = search.toString();
    return request<ClaimPage>(`/api/ledger/claims${query.length > 0 ? `?${query}` : ""}`);
  },

  getClaim(id: string): Promise<{ claim: Claim; history: Claim[] }> {
    return request<{ claim: Claim; history: Claim[] }>(
      `/api/ledger/claims/${encodeURIComponent(id)}`,
    );
  },

  listSubjects(): Promise<{ subjects: SubjectSummary[] }> {
    return request<{ subjects: SubjectSummary[] }>("/api/ledger/subjects");
  },

  demoState(): Promise<DemoState> {
    return request<DemoState>("/api/demo/history");
  },

  loadDemo(): Promise<{ created: boolean; conversation: Conversation }> {
    return request<{ created: boolean; conversation: Conversation }>(
      "/api/demo/history",
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ timezone: browserTimezone() }),
      },
    );
  },
};

export type StreamHandlers = {
  onDecision: (decision: RouteDecision) => void;
  onStep: (step: StepEvent) => void;
  onSources: (citations: Citation[]) => void;
  onBlock: (block: AnswerBlock) => void;
  onDelta: (index: number, text: string) => void;
};

export type StreamOutcome =
  | { ok: true; result: AskResponse }
  | { ok: false; error: StreamError | null; message: string };

type Frame = { event: string; data: string };

/**
 * SSE over `fetch`, because `EventSource` cannot POST a body. The server writes
 * one JSON object per `data:` line, so a frame is cheap to parse and a frame
 * split across two TCP reads is buffered before parsing.
 */
export async function askStream(
  conversationId: string,
  text: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<StreamOutcome> {
  const response = await fetch(
    `/api/conversations/${conversationId}/ask/stream`,
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ text }),
      signal,
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      missing?: string[];
      hint?: string;
    } | null;
    const message = body?.error ?? `request failed (${response.status})`;
    const hint = body?.hint ?? null;
    return {
      ok: false,
      error: null,
      message: hint === null ? message : `${message} — ${hint}`,
    };
  }

  if (response.body === null) {
    return { ok: false, error: null, message: "this browser cannot read streams" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const outcome: { done: AskResponse | null; failure: StreamError | null } = {
    done: null,
    failure: null,
  };

  const dispatch = (frame: Frame): void => {
    if (frame.data.length === 0) return;

    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      return;
    }

    switch (frame.event) {
      case "decision":
        handlers.onDecision(payload as RouteDecision);
        return;
      case "step":
        handlers.onStep(payload as StepEvent);
        return;
      case "sources":
        handlers.onSources((payload as { citations: Citation[] }).citations);
        return;
      case "block":
        handlers.onBlock(payload as AnswerBlock);
        return;
      case "delta": {
        const delta = payload as { index: number; text: string };
        handlers.onDelta(delta.index, delta.text);
        return;
      }
      case "done":
        outcome.done = payload as AskResponse;
        return;
      case "error":
        outcome.failure = payload as StreamError;
        return;
      default:
        return;
    }
  };

  while (true) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
      dispatch({ event, data: data.join("\n") });

      split = buffer.indexOf("\n\n");
    }
  }

  if (outcome.failure !== null) {
    return { ok: false, error: outcome.failure, message: outcome.failure.message };
  }
  if (outcome.done === null) {
    return { ok: false, error: null, message: "the stream ended before the answer did" };
  }
  return { ok: true, result: outcome.done };
}
