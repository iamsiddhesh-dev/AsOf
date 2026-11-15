/** The shapes the API actually returns. Mirrored, not generated, on purpose. */

export type ResolvedRange = { start: string; end: string; label: string };

export type RouteStep = {
  action: string;
  reason: string;
  timeRange: ResolvedRange | null;
  query: string | null;
  mode: "claims" | "news" | null;
  requiresSearch: boolean;
  bypassCache: boolean;
};

export type RouteDecision = {
  intent: "meta" | "recall" | "revalidate" | "clarify" | "search";
  confidence: "high" | "medium" | "low";
  reason?: string;
  timeRange: ResolvedRange | null;
  steps: RouteStep[];
  blockedBy: string | null;
};

export type Citation = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string;
};

export type TurnSource = {
  label: string;
  position: number;
  id: string;
  title: string | null;
  url: string;
  domain: string;
  publishedAt: string | null;
  fetchedAt: string;
  snippet: string | null;
};

export type Turn = {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  model: string | null;
  latencyMs: number | null;
  tokenIn: number | null;
  tokenOut: number | null;
  status: string;
  resolvedStart: string | null;
  resolvedEnd: string | null;
  resolvedLabel: string | null;
  intent: string | null;
  claimsStatus: string;
  traceId: string | null;
  parentTurnId: string | null;
  isDemo: boolean;
  sources: TurnSource[];
};

export type Conversation = {
  id: string;
  title: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
};

export type ClaimStatus = "active" | "superseded" | "retracted" | "unknown";

export type ClaimSource = {
  id: string;
  title: string | null;
  url: string;
  domain: string;
  publishedAt: string | null;
  fetchedAt: string;
};

export type Claim = {
  id: string;
  subject: string;
  attribute: string;
  claimType: string;
  value: string | null;
  unit: string | null;
  currency: string | null;
  period: string | null;
  status: ClaimStatus;
  confidence: number;
  observedAt: string;
  createdAt: string;
  quote: string;
  supersedesClaimId: string | null;
  turnId: string;
  conversationId: string;
  conversationTitle: string | null;
  source: ClaimSource | null;
};

export type ClaimPage = {
  claims: Claim[];
  total: number;
  limit: number;
  offset: number;
};

export type SubjectSummary = {
  subject: string;
  active: number;
  superseded: number;
  lastObservedAt: string;
};

export type Stats = {
  schemaVersion: number;
  counts: Record<string, number>;
};

export type AnswerBlockKind =
  | "chat"
  | "clarify"
  | "recall"
  | "recheck"
  | "search";

export type AnswerBlock = {
  index: number;
  kind: AnswerBlockKind;
  text: string;
};

export type AnswerStep = {
  action: string;
  status: "done" | "blocked" | "not_built";
  detail: string;
};

export type StepEvent = {
  action: string;
  status: "running" | "done" | "blocked" | "not_built";
  detail?: string;
};

export type ClaimsSummary = {
  inserted: number;
  superseded: number;
  dropped: number;
  reason: string | null;
};

export type StreamError = {
  message: string;
  provider: string | null;
  status: number | null;
  retryable: boolean;
  userTurnId: string | null;
};

export type AskResponse = {
  answer: string;
  steps: AnswerStep[];
  citations: Citation[];
  grounded: boolean | null;
  model: string | null;
  latencyMs: number;
  tokenIn: number | null;
  tokenOut: number | null;
  blockedBy: string | null;
  demo: boolean;
  recheck: { status: "done" | "blocked"; verdicts: unknown[] } | null;
  claims: ClaimsSummary;
  claimsStatus: "done" | "failed" | "skipped";
  decision: RouteDecision;
  userTurnId: string;
  assistantTurnId: string;
};

export type DemoState = {
  loaded: boolean;
  conversation: Conversation | null;
};

/** What the inspector needs to render a source, from either a turn or a stream. */
export type SourceDetail = {
  label: string;
  title: string | null;
  url: string;
  domain: string;
  publishedAt: string | null;
  fetchedAt: string | null;
  snippet: string | null;
};

export type InspectorTarget =
  | { kind: "source"; source: SourceDetail }
  | { kind: "claim"; claimId: string };
