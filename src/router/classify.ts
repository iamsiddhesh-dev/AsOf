import type { ConversationState } from "../conversations/state.js";
import {
  hasTemporalReference,
  resolveDateRange,
  type ResolvedRange,
} from "../time/resolve.js";

export type RouteIntent = "meta" | "recall" | "revalidate" | "clarify" | "search";

/** What the executor should actually do, in order. */
export type RouteAction = "chat" | "recall" | "recheck" | "search";

export type RouteMode = "claims" | "news";

export type RouteConfidence = "high" | "medium" | "low";

export type BlockedBy = "no_prior_answer" | "no_entity_set" | "unresolved_date" | null;

export type RouteStep = {
  action: RouteAction;
  reason: string;
  timeRange: ResolvedRange | null;
  /** Present when the step needs a search: the text to search for. */
  query: string | null;
  /** Recheck only: diff stored claims, or look for dated news after the anchor. */
  mode: RouteMode | null;
  requiresSearch: boolean;
  bypassCache: boolean;
};

export type RouteDecision = {
  intent: RouteIntent;
  confidence: RouteConfidence;
  reason: string;
  timeRange: ResolvedRange | null;
  /** Ordered plan. One entry for a simple question, several for a compound one. */
  steps: RouteStep[];
  requiresSearch: boolean;
  bypassCache: boolean;
  clarification: string | null;
  blockedBy: BlockedBy;
};

export type RouteInput = {
  text: string;
  now: Date;
  timezone: string;
  state?: ConversationState | null;
  lastAnswerAt?: string | null;
  priorClaimCount?: number;
};

type PatternRule = {
  re: RegExp;
  label: string;
  referentless?: boolean;
  requireEntitySet?: boolean;
};

const META_RULES: PatternRule[] = [
  {
    re: /^(?:hi|hello|hey|yo|howdy|good (?:morning|afternoon|evening))[\s!,.]*$/i,
    label: "greeting",
  },
  {
    re: /^(?:thanks|thank you|cheers|nice|great|ok|okay|cool)[\s!,.]*$/i,
    label: "acknowledgement",
  },
  {
    re: /^(?:help|what can you do|what can you help with|who are you|what are you|how do you work)\s*\??$/i,
    label: "capability question",
  },
];

const RECALL_RULES: PatternRule[] = [
  {
    re: /\bwhat did (?:i|we) (?:ask|say|tell|share|mention|decide|choose|pick|send|do)\b/i,
    label: "what did i ask",
  },
  {
    re: /\bwhat (?:have|had) (?:i|we) (?:asked|said|told|mentioned|shared|decided)\b/i,
    label: "what have i asked",
  },
  {
    re: /\bwhat did (?:you|asof) (?:say|answer|tell|recommend|suggest|find|report)\b/i,
    label: "what did you say",
  },
  {
    re: /\bwhat (?:was|were) (?:i|we|you) (?:talking|discussing|asking) about\b/i,
    label: "what were we discussing",
  },
  {
    re: /\bwhat did we (?:discuss|talk about|cover)\b/i,
    label: "what did we discuss",
  },
  {
    re: /\b(?:remind me|show me|recall|pull up)\b[^?]*\b(?:said|asked|told|mentioned|discussed|covered|conversation|answer|earlier|previously)\b/i,
    label: "remind me",
  },
];

const REVALIDATE_RULES: PatternRule[] = [
  {
    re: /\b(?:any|all|none|some|each|both) of (?:them|those|these)\b/i,
    label: "any of them",
    referentless: true,
    requireEntitySet: true,
  },
  {
    re: /\b(?:is|are|was|were) (?:it|that|this|they|those|these) still\b/i,
    label: "is it still",
    referentless: true,
  },
  {
    re: /\bstill (?:true|correct|accurate|valid|right|the case|available|in stock)\b/i,
    label: "still true",
    referentless: true,
  },
  {
    re: /\bhas (?:it|that|this|anything)\b[^?]*\b(?:changed|moved|dropped|risen|increased|decreased|been updated)\b/i,
    label: "has it changed",
    referentless: true,
  },
  {
    re: /\bwhat (?:has )?changed\b/i,
    label: "what changed",
    referentless: true,
  },
  {
    re: /\b(?:re-?check|check again|verify (?:that|this|it))\b/i,
    label: "recheck",
    referentless: true,
  },
  {
    re: /\bdid (?:that|it|this|they) change\b/i,
    label: "did it change",
    referentless: true,
  },
  {
    re: /\bany (?:material )?(?:changes?|updates?)\b/i,
    label: "any changes",
  },
  {
    re: /\bhas\b[^?]{1,60}\bchanged\b/i,
    label: "has ... changed",
  },
  {
    re: /\bupdate me on\b/i,
    label: "update me on",
  },
];

const NEWS_RULE = /\b(?:shipped|launch(?:ed|es)?|released|announced|news|updates?)\b/i;

const ENTITY_SET_PRONOUN = /\b(?:any|all|none|some|each|both) of (?:them|those|these)\b/i;

/**
 * Compound messages are the normal case, not the exception:
 * "What did I ask on 3 November? Is your answer still correct?"
 * splits into a recall step and a recheck step.
 */
const SEGMENT_SPLIT =
  /(?<=[?;])\s+|\s+(?:and then|and also|then|also)\s+|\s+and\s+(?=(?:is|are|was|were|has|have|did|does|do|what|why|how|can|could|should|will)\b)/i;

const INTENT_TO_ACTION: Record<RouteIntent, RouteAction> = {
  meta: "chat",
  recall: "recall",
  revalidate: "recheck",
  clarify: "chat",
  search: "search",
};

const ACTION_TO_INTENT: Record<RouteAction, RouteIntent> = {
  chat: "meta",
  recall: "recall",
  recheck: "revalidate",
  search: "search",
};

function firstMatch(rules: PatternRule[], text: string): PatternRule | null {
  for (const rule of rules) {
    if (rule.re.test(text)) {
      return rule;
    }
  }
  return null;
}

function hasEntityReference(state: ConversationState | null): boolean {
  if (state === null) {
    return false;
  }
  return state.activeEntitySet !== null || state.activeEntities.length > 0;
}

function segment(text: string): string[] {
  const parts = text
    .split(SEGMENT_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
  return parts.length > 0 ? parts : [text];
}

type SingleDecision = Omit<RouteDecision, "steps">;

function classifySegment(
  text: string,
  input: RouteInput,
  hasPriorAnswer: boolean,
): SingleDecision {
  const timeRange = resolveDateRange(text, {
    now: input.now,
    timezone: input.timezone,
    lastAnswerAt: input.lastAnswerAt ?? null,
    direction: "past",
  });

  const decide = (
    intent: RouteIntent,
    values: Partial<Omit<SingleDecision, "intent">> = {},
  ): SingleDecision => ({
    intent,
    confidence: "medium",
    reason: "",
    timeRange,
    requiresSearch: intent === "search" || intent === "revalidate",
    bypassCache: intent === "revalidate",
    clarification: null,
    blockedBy: null,
    ...values,
  });

  const meta = firstMatch(META_RULES, text);
  if (meta !== null) {
    return decide("meta", {
      confidence: "high",
      reason: `matched ${meta.label}`,
      requiresSearch: false,
      bypassCache: false,
    });
  }

  const revalidate = firstMatch(REVALIDATE_RULES, text);
  if (revalidate !== null) {
    if (revalidate.requireEntitySet && !hasEntityReference(input.state ?? null)) {
      return decide("clarify", {
        confidence: "low",
        reason: `matched "${revalidate.label}" but no active entity set is stored`,
        requiresSearch: false,
        bypassCache: false,
        clarification:
          "Which ones do you mean? I do not have an active list in this conversation yet.",
        blockedBy: "no_entity_set",
      });
    }

    if (revalidate.referentless && !hasPriorAnswer) {
      return decide("clarify", {
        confidence: "low",
        reason: `matched "${revalidate.label}" but there is no prior answer to recheck`,
        requiresSearch: false,
        bypassCache: false,
        clarification:
          "I do not have a previous answer to recheck yet. What should I look up first?",
        blockedBy: "no_prior_answer",
      });
    }

    if (!hasPriorAnswer) {
      return decide("search", {
        confidence: "medium",
        reason: `matched "${revalidate.label}" but no stored claims; treated as a fresh search`,
      });
    }

    return decide("revalidate", {
      confidence: "high",
      reason: `matched "${revalidate.label}" and a prior answer exists`,
    });
  }

  const recall = firstMatch(RECALL_RULES, text);
  if (recall !== null) {
    if (
      timeRange === null &&
      /\bsince (?:then|the last answer|my last answer)\b/i.test(text)
    ) {
      return decide("clarify", {
        confidence: "low",
        reason: `matched "${recall.label}" but "since then" has no anchor`,
        requiresSearch: false,
        bypassCache: false,
        clarification:
          "I do not have a previous answer to anchor \"since then\". Which date should I use?",
        blockedBy: "no_prior_answer",
      });
    }

    if (timeRange === null && hasTemporalReference(text)) {
      return decide("clarify", {
        confidence: "low",
        reason: `matched "${recall.label}" but the date could not be resolved`,
        requiresSearch: false,
        bypassCache: false,
        clarification: "Which date did you mean? I could not resolve that one.",
        blockedBy: "unresolved_date",
      });
    }

    return decide("recall", {
      confidence: timeRange === null ? "medium" : "high",
      reason:
        timeRange === null
          ? `matched "${recall.label}" for the most recent turns`
          : `matched "${recall.label}" inside ${timeRange.label}`,
      requiresSearch: false,
      bypassCache: false,
    });
  }

  if (ENTITY_SET_PRONOUN.test(text) && !hasEntityReference(input.state ?? null)) {
    return decide("clarify", {
      confidence: "low",
      reason: "pronoun refers to an entity set that is not stored",
      requiresSearch: false,
      bypassCache: false,
      clarification:
        "Which ones do you mean? I do not have an active list in this conversation yet.",
      blockedBy: "no_entity_set",
    });
  }

  if (timeRange !== null && hasTemporalReference(text)) {
    return decide("search", {
      confidence: "medium",
      reason: `default lane, limited to ${timeRange.label}`,
    });
  }

  return decide("search", {
    confidence: "medium",
    reason: "default lane: factual questions search",
  });
}

function toStep(decision: SingleDecision, text: string): RouteStep {
  const action = INTENT_TO_ACTION[decision.intent];
  return {
    action,
    reason: decision.reason,
    timeRange: decision.timeRange,
    query: action === "search" || action === "recheck" ? text : null,
    mode:
      action === "recheck" ? (NEWS_RULE.test(text) ? "news" : "claims") : null,
    requiresSearch: decision.requiresSearch,
    bypassCache: decision.bypassCache,
  };
}

export function classify(input: RouteInput): RouteDecision {
  const text = input.text.trim().replace(/\s+/g, " ");

  if (text.length === 0) {
    return {
      intent: "clarify",
      confidence: "low",
      reason: "empty input",
      timeRange: null,
      steps: [],
      requiresSearch: false,
      bypassCache: false,
      clarification: "What would you like to ask?",
      blockedBy: null,
    };
  }

  const hasPriorAnswer =
    (input.priorClaimCount ?? 0) > 0 || Boolean(input.state?.lastAnswerTurnId);

  const segments = segment(text);
  const decisions = segments.map((part) => classifySegment(part, input, hasPriorAnswer));

  // "What did I ask on 3 November? Is that still correct?" — the recheck is
  // blocked on a prior answer, but the recall in the same message provides one.
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    if (
      decision !== undefined &&
      decision.intent === "clarify" &&
      decision.blockedBy === "no_prior_answer" &&
      decisions.slice(0, index).some((prior) => prior.intent === "recall")
    ) {
      decisions[index] = {
        ...decision,
        intent: "revalidate",
        confidence: "high",
        reason: `${decision.reason}; rechecked after the recall in the same message`,
        requiresSearch: true,
        bypassCache: true,
        clarification: null,
        blockedBy: null,
      };
    }
  }

  const actionables = decisions.filter((decision) => decision.intent !== "meta");
  const considered = actionables.length > 0 ? actionables : decisions;
  const steps = considered
    .map((decision) => ({
      decision,
      segment: segments[decisions.indexOf(decision)] ?? text,
    }))
    .filter((entry) => entry.decision.intent !== "clarify")
    .map((entry) => toStep(entry.decision, entry.segment));

  const clarification =
    decisions.find((decision) => decision.clarification !== null)?.clarification ??
    null;

  if (steps.length === 0) {
    const blocked = decisions.find((decision) => decision.blockedBy !== null);
    const first = decisions[0];
    return {
      intent: "clarify",
      confidence: "low",
      reason: first?.reason ?? "nothing executable",
      timeRange: first?.timeRange ?? null,
      steps: [],
      requiresSearch: false,
      bypassCache: false,
      clarification,
      blockedBy: blocked?.blockedBy ?? null,
    };
  }

  const primary = steps[0] as RouteStep;
  const confidence: RouteConfidence = decisions.some(
    (decision) => decision.confidence === "low",
  )
    ? "medium"
    : decisions.every((decision) => decision.confidence === "high")
      ? "high"
      : "medium";

  return {
    intent: ACTION_TO_INTENT[primary.action],
    confidence,
    reason: decisions.map((decision) => decision.reason).join(" + "),
    timeRange: primary.timeRange,
    steps,
    requiresSearch: steps.some((step) => step.requiresSearch),
    bypassCache: steps.some((step) => step.bypassCache),
    clarification,
    blockedBy: null,
  };
}
