export type ConversationState = {
  activeEntities: Array<{ id: string; name: string }>;
  activeEntitySet: {
    id: string;
    name: string;
    members: string[];
  } | null;
  lastAnswerTurnId: string | null;
  lastTopic: string | null;
  resolvedTimeRange: {
    start: string;
    end: string;
    label: string;
  } | null;
  pendingClarification: string | null;
};

export function emptyConversationState(): ConversationState {
  return {
    activeEntities: [],
    activeEntitySet: null,
    lastAnswerTurnId: null,
    lastTopic: null,
    resolvedTimeRange: null,
    pendingClarification: null,
  };
}

export function parseConversationState(value: string): ConversationState {
  try {
    const parsed = JSON.parse(value) as Partial<ConversationState>;
    const base = emptyConversationState();
    return {
      ...base,
      ...parsed,
      activeEntities: Array.isArray(parsed.activeEntities)
        ? parsed.activeEntities
        : base.activeEntities,
      activeEntitySet:
        parsed.activeEntitySet === null || parsed.activeEntitySet === undefined
          ? base.activeEntitySet
          : parsed.activeEntitySet,
      lastAnswerTurnId:
        typeof parsed.lastAnswerTurnId === "string"
          ? parsed.lastAnswerTurnId
          : null,
      lastTopic: typeof parsed.lastTopic === "string" ? parsed.lastTopic : null,
      resolvedTimeRange:
        parsed.resolvedTimeRange === null || parsed.resolvedTimeRange === undefined
          ? base.resolvedTimeRange
          : parsed.resolvedTimeRange,
      pendingClarification:
        typeof parsed.pendingClarification === "string"
          ? parsed.pendingClarification
          : null,
    };
  } catch {
    return emptyConversationState();
  }
}
