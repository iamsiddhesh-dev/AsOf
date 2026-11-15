import type { Db } from "../db/index.js";
import {
  memoryStats,
  recallTurnsEverywhere,
  recentTurnsEverywhere,
  type Turn,
} from "../conversations/repository.js";
import {
  hasTemporalReference,
  resolveDateRange,
  type ResolvedRange,
} from "../time/resolve.js";

export type RecallOptions = {
  text: string;
  now: Date;
  timezone: string;
  keyword?: string | null;
  limit?: number;
  lastAnswerAt?: string | null;
};

export type RecallResult = {
  found: boolean;
  range: ResolvedRange | null;
  turns: Turn[];
  message: string;
  memoryStartsAt: string | null;
  demo: boolean;
};

export function formatLocalDate(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Recall is answered from the database, never from the model.
 *
 * When the window is empty the reply says so and names the first day this
 * ledger holds, because a confident answer about a day you never stored is
 * indistinguishable from a hallucination.
 */
export function answerRecall(db: Db, options: RecallOptions): RecallResult {
  const limit = options.limit ?? 200;
  const range = resolveDateRange(options.text, {
    now: options.now,
    timezone: options.timezone,
    lastAnswerAt: options.lastAnswerAt ?? null,
    direction: "past",
  });

  const stats = memoryStats(db);
  const turns =
    range === null
      ? recentTurnsEverywhere(db, Math.min(limit, 20)).filter((turn) =>
          options.keyword === undefined || options.keyword === null
            ? true
            : turn.content.toLowerCase().includes(options.keyword.toLowerCase()),
        )
      : recallTurnsEverywhere(db, range, { keyword: options.keyword ?? null, limit });

  const demo = turns.some((turn) => turn.isDemo);
  const demoNote = demo
    ? " Some of these turns are demo history, not your own words."
    : "";

  if (turns.length > 0) {
    const scope =
      range === null ? "in this ledger" : `from ${range.label}`;
    return {
      found: true,
      range,
      turns,
      message: `I found ${plural(turns.length, "turn")} ${scope}.${demoNote}`,
      memoryStartsAt: stats.firstTurnAt,
      demo,
    };
  }

  const days = range === null ? "for that period" : `from ${range.label}`;

  if (stats.turns === 0) {
    return {
      found: false,
      range,
      turns: [],
      message: `I have no record ${days}. Nothing has been stored in this ledger yet, so there is nothing to recall.`,
      memoryStartsAt: null,
      demo: false,
    };
  }

  const startsAt =
    stats.firstTurnAt === null
      ? null
      : formatLocalDate(stats.firstTurnAt, options.timezone);

  return {
    found: false,
    range,
    turns: [],
    message:
      startsAt === null
        ? `I have no record ${days}.`
        : `I have no record ${days}. My memory starts ${startsAt}, when this install first stored a turn.`,
    memoryStartsAt: stats.firstTurnAt,
    demo: false,
  };
}

/** True when the message asks about memory but names no resolvable window. */
export function isDateLessRecall(text: string): boolean {
  return !hasTemporalReference(text);
}
