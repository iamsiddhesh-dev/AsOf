import type {
  AnswerBlockKind,
  Citation,
  RouteDecision,
  StepEvent,
} from "../lib/types.js";

export type StreamPart = { text: string; kind: AnswerBlockKind | null };

export type StreamState = {
  question: string;
  decision: RouteDecision | null;
  steps: StepEvent[];
  sources: Citation[];
  parts: Record<number, StreamPart>;
  startedAt: number;
};

/**
 * `step` events arrive as `running` and then as a terminal status. A compound
 * question can plan the same action twice, so completion finds the last
 * running row with that action rather than the first one.
 */
export function upsertStep(steps: StepEvent[], event: StepEvent): StepEvent[] {
  const next = [...steps];

  if (event.status === "running") {
    next.push(event);
    return next;
  }

  for (let index = next.length - 1; index >= 0; index -= 1) {
    const candidate = next[index];
    if (
      candidate !== undefined &&
      candidate.action === event.action &&
      candidate.status === "running"
    ) {
      next[index] = {
        ...candidate,
        ...event,
        detail: event.detail ?? candidate.detail,
      };
      return next;
    }
  }

  next.push(event);
  return next;
}

export function appendDelta(
  parts: Record<number, StreamPart>,
  index: number,
  text: string,
): Record<number, StreamPart> {
  const current = parts[index];
  return {
    ...parts,
    [index]: {
      text: (current?.text ?? "") + text,
      kind: current?.kind ?? null,
    },
  };
}

export function partList(parts: Record<number, StreamPart>) {
  return Object.entries(parts)
    .map(([index, part]) => ({ index: Number(index), ...part }))
    .sort((left, right) => left.index - right.index);
}

export function partKindLabel(kind: AnswerBlockKind): string | null {
  switch (kind) {
    case "chat":
      return "Reply";
    case "clarify":
      return "Needs a referent";
    case "recall":
      return "From the ledger";
    case "recheck":
      return "Recheck";
    case "search":
      return null;
  }
}
