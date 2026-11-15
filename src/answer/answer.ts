import type { Db } from "../db/index.js";
import { answerRecall, formatLocalDate } from "../memory/recall.js";
import type { ChatClient, SearchClient, SearchResult } from "../providers/types.js";
import type {
  BlockedBy,
  RouteAction,
  RouteDecision,
  RouteStep,
} from "../router/classify.js";

export type Citation = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  /** The evidence text the model was allowed to use. */
  snippet: string;
};

export type AnswerStepStatus = "done" | "blocked" | "not_built";

export type AnswerStep = {
  action: RouteAction;
  status: AnswerStepStatus;
  detail: string;
};

export type AnswerResult = {
  answer: string;
  steps: AnswerStep[];
  citations: Citation[];
  /** null when no synthesis ran, so the question never needed grounding. */
  grounded: boolean | null;
  model: string | null;
  latencyMs: number;
  tokenIn: number | null;
  tokenOut: number | null;
  blockedBy: BlockedBy;
  demo: boolean;
};

export type AnswerDeps = {
  search: SearchClient;
  chat: ChatClient;
  model: string;
};

export type AnswerInput = {
  text: string;
  timezone: string;
  now: Date;
  decision: RouteDecision;
  /** Hand-supplied keyword for date-range recall; extraction is a model job. */
  keyword?: string | null;
};

const MAX_SOURCES = 5;

const SYNTH_SYSTEM = `You answer questions using only the numbered evidence provided.

Rules:
1. Cite every factual sentence with the matching id, exactly as [s1], [s2].
2. Never state a number, date, or price that is not in the evidence.
3. If sources disagree, prefer the most recent and say that it changed.
4. If the evidence cannot answer the question, say what is missing. Do not guess.
5. Two to four sentences. No preamble, no headings, no bullet lists.`;

const CHAT_REPLY =
  "I'm AsOf. I can recall what this ledger has stored, plan a recheck, and search for answers with cited sources. Ask what you did on a date, or ask a factual question.";

function clarifyMessage(blockedBy: BlockedBy): string {
  switch (blockedBy) {
    case "no_prior_answer":
      return "I don't have a previous answer in this ledger to recheck. Ask the question first, then I can check whether it changed.";
    case "no_entity_set":
      return "I don't know what \"them\" refers to. Name the tools or topics you mean and I'll check each one.";
    case "unresolved_date":
      return "I couldn't resolve that date to a specific day. Give me a date and I'll look.";
    default:
      return "I need a bit more detail before I can answer that.";
  }
}

function recheckMessage(step: RouteStep): string {
  return step.mode === "news"
    ? "I can plan that news check, but dated-claim extraction is not built yet, so I have nothing to compare. I won't claim nothing changed."
    : "I can plan that recheck, but claims extraction is not built yet, so there is nothing to diff. I won't guess whether it changed.";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function evidenceBlock(sources: SearchResult[], firstIndex: number): string {
  return sources
    .map((source, offset) => {
      const id = `s${firstIndex + offset + 1}`;
      const published =
        source.publishedAt === null ? "" : `, published ${source.publishedAt}`;
      return `[${id}] ${source.title} (${hostOf(source.url)}${published})\n${source.url}\n"${source.snippet}"`;
    })
    .join("\n\n");
}

function toCitations(sources: SearchResult[], firstIndex: number): Citation[] {
  return sources.map((source, offset) => ({
    id: `s${firstIndex + offset + 1}`,
    title: source.title,
    url: source.url,
    publishedAt: source.publishedAt,
    snippet: source.snippet,
  }));
}

function citedIds(text: string, citations: Citation[]): string[] {
  const valid = new Set(citations.map((citation) => citation.id));
  const found = [...text.matchAll(/\[s(\d+)\]/g)].map((match) => `s${match[1]}`);
  return [...new Set(found)].filter((id) => valid.has(id));
}

function formatRecall(
  db: Db,
  input: AnswerInput,
): { text: string; demo: boolean } {
  const recall = answerRecall(db, {
    text: input.text,
    now: input.now,
    timezone: input.timezone,
    keyword: input.keyword ?? null,
    limit: 20,
  });

  if (!recall.found) {
    return { text: recall.message, demo: false };
  }

  const scope = recall.range?.label ?? "your ledger";
  const lines = recall.turns.map(
    (turn) =>
      `- ${formatLocalDate(turn.createdAt, input.timezone)} (${turn.role}): ${turn.content}`,
  );
  const demoNote = recall.demo
    ? " Some of these turns are demo history, not your own words."
    : "";

  return {
    text: `From ${scope}:\n${lines.join("\n")}${demoNote}`,
    demo: recall.demo,
  };
}

type SearchStepResult = {
  text: string;
  citations: Citation[];
  grounded: boolean;
  model: string | null;
  tokenIn: number | null;
  tokenOut: number | null;
};

async function runSearch(
  step: RouteStep,
  input: AnswerInput,
  deps: AnswerDeps,
  firstIndex: number,
): Promise<SearchStepResult> {
  const query = step.query ?? input.text;
  const response = await deps.search.search(query, {
    maxResults: MAX_SOURCES,
    bypassCache: step.bypassCache,
  });

  if (response.results.length === 0) {
    return {
      text: `I searched for "${query}" and found no usable sources, so I won't guess.`,
      citations: [],
      grounded: false,
      model: null,
      tokenIn: null,
      tokenOut: null,
    };
  }

  const citations = toCitations(response.results, firstIndex);
  const completion = await deps.chat.chat({
    model: deps.model,
    messages: [
      { role: "system", content: SYNTH_SYSTEM },
      {
        role: "user",
        content: `Question: ${input.text}\n\nEvidence:\n${evidenceBlock(response.results, firstIndex)}`,
      },
    ],
    maxTokens: 700,
    temperature: 0,
  });

  return {
    text: completion.content,
    citations,
    grounded: citedIds(completion.content, citations).length > 0,
    model: completion.model,
    tokenIn: completion.usage.input,
    tokenOut: completion.usage.output,
  };
}

/**
 * Executes the router's plan. The router decides; this only does what it was
 * told, in order, and reports each step so a half-answered compound question is
 * visible rather than hidden inside one paragraph.
 */
export async function answerQuestion(
  db: Db,
  deps: AnswerDeps,
  input: AnswerInput,
): Promise<AnswerResult> {
  const started = Date.now();
  const { decision } = input;

  if (decision.steps.length === 0) {
    return {
      answer: clarifyMessage(decision.blockedBy),
      steps: [],
      citations: [],
      grounded: null,
      model: null,
      latencyMs: Date.now() - started,
      tokenIn: null,
      tokenOut: null,
      blockedBy: decision.blockedBy,
      demo: false,
    };
  }

  const parts: string[] = [];
  const steps: AnswerStep[] = [];
  const citations: Citation[] = [];
  let model: string | null = null;
  let demo = false;
  let sawSearch = false;
  let allGrounded = true;
  let tokenIn: number | null = null;
  let tokenOut: number | null = null;

  for (const step of decision.steps) {
    if (step.action === "chat") {
      parts.push(CHAT_REPLY);
      steps.push({ action: "chat", status: "done", detail: "fixed reply" });
      continue;
    }

    if (step.action === "recall") {
      const recall = formatRecall(db, input);
      parts.push(recall.text);
      demo = demo || recall.demo;
      steps.push({
        action: "recall",
        status: "done",
        detail: recall.demo ? "read from demo history" : "read from the ledger",
      });
      continue;
    }

    if (step.action === "recheck") {
      parts.push(recheckMessage(step));
      steps.push({
        action: "recheck",
        status: "not_built",
        detail: `mode ${step.mode ?? "claims"}: claim extraction is not built`,
      });
      continue;
    }

    sawSearch = true;
    const result = await runSearch(step, input, deps, citations.length);
    parts.push(result.text);
    citations.push(...result.citations);
    if (result.model !== null) {
      model = result.model;
    }
    if (result.tokenIn !== null) {
      tokenIn = (tokenIn ?? 0) + result.tokenIn;
    }
    if (result.tokenOut !== null) {
      tokenOut = (tokenOut ?? 0) + result.tokenOut;
    }
    allGrounded = allGrounded && result.grounded;
    steps.push({
      action: "search",
      status: "done",
      detail: `${result.citations.length} source(s)`,
    });
  }

  return {
    answer: parts.join("\n\n"),
    steps,
    citations,
    grounded: sawSearch ? allGrounded : null,
    model,
    latencyMs: Date.now() - started,
    tokenIn,
    tokenOut,
    blockedBy: decision.blockedBy,
    demo,
  };
}
