import type { ConversationState } from "../conversations/state.js";
import {
  hasTemporalReference,
  resolveDateRange,
  type ResolvedRange,
} from "../time/resolve.js";

export type RouteIntent = "meta" | "recall" | "revalidate" | "clarify" | "search";

export type RouteConfidence = "high" | "medium" | "low";

export type RouteDecision = {
  intent: RouteIntent;
  confidence: RouteConfidence;
  reason: string;
  timeRange: ResolvedRange | null;
  requiresSearch: boolean;
  bypassCache: boolean;
  clarification: string | null;
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
    re: /\b(?:remind me|show me|recall|pull up)\b[^?]*\b(?:said|asked|told|mentioned|discussed|conversation|answer|earlier|previously)\b/i,
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

const ENTITY_SET_PRONOUN = /\b(?:any|all|none|some|each|both) of (?:them|those|these)\b/i;

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

export function classify(input: RouteInput): RouteDecision {
  const text = input.text.trim().replace(/\s+/g, " ");
  const state = input.state ?? null;
  const priorClaimCount = input.priorClaimCount ?? 0;
  const hasPriorAnswer = priorClaimCount > 0 || Boolean(state?.lastAnswerTurnId);
  const timeRange = resolveDateRange(text, {
    now: input.now,
    timezone: input.timezone,
    lastAnswerAt: input.lastAnswerAt ?? null,
    direction: "past",
  });

  const decide = (
    intent: RouteIntent,
    values: Partial<Omit<RouteDecision, "intent">> = {},
  ): RouteDecision => ({
    intent,
    confidence: "medium",
    reason: "",
    timeRange,
    requiresSearch: intent === "search" || intent === "revalidate",
    bypassCache: intent === "revalidate",
    clarification: null,
    ...values,
  });

  if (text.length === 0) {
    return decide("clarify", {
      confidence: "low",
      reason: "empty input",
      clarification: "What would you like to ask?",
    });
  }

  const meta = firstMatch(META_RULES, text);
  if (meta !== null) {
    return decide("meta", {
      confidence: "high",
      reason: `matched ${meta.label}`,
    });
  }

  const revalidate = firstMatch(REVALIDATE_RULES, text);
  if (revalidate !== null) {
    if (revalidate.requireEntitySet && !hasEntityReference(state)) {
      return decide("clarify", {
        confidence: "low",
        reason: `matched "${revalidate.label}" but no active entity set is stored`,
        clarification:
          "Which ones do you mean? I do not have an active list in this conversation yet.",
      });
    }

    if (revalidate.referentless && !hasPriorAnswer) {
      return decide("clarify", {
        confidence: "low",
        reason: `matched "${revalidate.label}" but there is no prior answer to recheck`,
        clarification:
          "I do not have a previous answer to recheck yet. What should I look up first?",
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
        clarification:
          "I do not have a previous answer to anchor \"since then\". Which date should I use?",
      });
    }

    if (timeRange === null && hasTemporalReference(text)) {
      return decide("clarify", {
        confidence: "low",
        reason: `matched "${recall.label}" but the date could not be resolved`,
        clarification: "Which date did you mean? I could not resolve that one.",
      });
    }

    return decide("recall", {
      confidence: timeRange === null ? "medium" : "high",
      reason:
        timeRange === null
          ? `matched "${recall.label}" for the most recent turns`
          : `matched "${recall.label}" inside ${timeRange.label}`,
    });
  }

  if (ENTITY_SET_PRONOUN.test(text) && !hasEntityReference(state)) {
    return decide("clarify", {
      confidence: "low",
      reason: "pronoun refers to an entity set that is not stored",
      clarification:
        "Which ones do you mean? I do not have an active list in this conversation yet.",
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
