import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import {
  emptyConversationState,
  parseConversationState,
  type ConversationState,
} from "./state.js";

export type Conversation = {
  id: string;
  title: string;
  timezone: string;
  state: ConversationState;
  createdAt: string;
  updatedAt: string;
};

export type TurnRole = "system" | "user" | "assistant" | "tool";

export type Turn = {
  id: string;
  conversationId: string;
  role: TurnRole;
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
  /** Only present on global memory reads, where turns span conversations. */
  conversationTitle?: string;
};

type ConversationRow = {
  id: string;
  title: string;
  timezone: string;
  state_json: string;
  created_at: string;
  updated_at: string;
};

type TurnRow = {
  id: string;
  conversation_id: string;
  role: TurnRole;
  content: string;
  created_at: string;
  model: string | null;
  latency_ms: number | null;
  token_in: number | null;
  token_out: number | null;
  status: string;
  resolved_start: string | null;
  resolved_end: string | null;
  resolved_label: string | null;
  intent: string | null;
  claims_status: string;
  trace_id: string | null;
  parent_turn_id: string | null;
  is_demo: number;
  conversation_title?: string;
};

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    timezone: row.timezone,
    state: parseConversationState(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTurn(row: TurnRow): Turn {
  const turn: Turn = {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    model: row.model,
    latencyMs: row.latency_ms,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    status: row.status,
    resolvedStart: row.resolved_start,
    resolvedEnd: row.resolved_end,
    resolvedLabel: row.resolved_label,
    intent: row.intent,
    claimsStatus: row.claims_status,
    traceId: row.trace_id,
    parentTurnId: row.parent_turn_id,
    isDemo: row.is_demo === 1,
  };

  if (row.conversation_title !== undefined) {
    turn.conversationTitle = row.conversation_title;
  }

  return turn;
}

export function createConversation(
  db: Db,
  input: { title: string; timezone: string; now?: Date },
): Conversation {
  const id = randomUUID();
  const now = (input.now ?? new Date()).toISOString();
  const state = emptyConversationState();

  db.prepare(
    `INSERT INTO conversations
      (id, title, timezone, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.title, input.timezone, JSON.stringify(state), now, now);

  const conversation = getConversation(db, id);
  if (conversation === null) {
    throw new Error("conversation insert failed");
  }
  return conversation;
}

export function listConversations(db: Db, limit = 50): Conversation[] {
  const rows = db
    .prepare(
      `SELECT id, title, timezone, state_json, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ConversationRow[];
  return rows.map(mapConversation);
}

export function getConversation(db: Db, id: string): Conversation | null {
  const row = db
    .prepare(
      `SELECT id, title, timezone, state_json, created_at, updated_at
       FROM conversations
       WHERE id = ?`,
    )
    .get(id) as ConversationRow | undefined;
  return row === undefined ? null : mapConversation(row);
}

export function getTurn(db: Db, id: string): Turn | null {
  const row = db
    .prepare("SELECT * FROM turns WHERE id = ?")
    .get(id) as TurnRow | undefined;
  return row === undefined ? null : mapTurn(row);
}

export type AppendTurnInput = {
  conversationId: string;
  role: TurnRole;
  content: string;
  createdAt?: string;
  parentTurnId?: string | null;
  resolvedStart?: string | null;
  resolvedEnd?: string | null;
  resolvedLabel?: string | null;
  intent?: string | null;
  model?: string | null;
  latencyMs?: number | null;
  tokenIn?: number | null;
  tokenOut?: number | null;
  isDemo?: boolean;
};

export function appendTurn(db: Db, input: AppendTurnInput): Turn {
  const conversation = getConversation(db, input.conversationId);
  if (conversation === null) {
    throw new Error("conversation not found");
  }

  const id = randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const state: ConversationState = conversation.state;

  if (input.role === "assistant") {
    state.lastAnswerTurnId = id;
  }

  if (
    input.role === "user" &&
    input.resolvedStart !== null &&
    input.resolvedStart !== undefined &&
    input.resolvedEnd !== null &&
    input.resolvedEnd !== undefined &&
    input.resolvedLabel !== null &&
    input.resolvedLabel !== undefined
  ) {
    state.resolvedTimeRange = {
      start: input.resolvedStart,
      end: input.resolvedEnd,
      label: input.resolvedLabel,
    };
  }

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO turns
        (id, conversation_id, role, content, created_at, model,
         latency_ms, token_in, token_out,
         resolved_start, resolved_end, resolved_label, intent, status,
         claims_status, parent_turn_id, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', 'pending', ?, ?)`,
    ).run(
      id,
      input.conversationId,
      input.role,
      input.content,
      createdAt,
      input.model ?? null,
      input.latencyMs ?? null,
      input.tokenIn ?? null,
      input.tokenOut ?? null,
      input.resolvedStart ?? null,
      input.resolvedEnd ?? null,
      input.resolvedLabel ?? null,
      input.intent ?? null,
      input.parentTurnId ?? null,
      input.isDemo === true ? 1 : 0,
    );

    db.prepare(
      "UPDATE conversations SET state_json = ?, updated_at = ? WHERE id = ?",
    ).run(
      JSON.stringify(state),
      new Date().toISOString(),
      input.conversationId,
    );
  });

  insert();

  const turn = getTurn(db, id);
  if (turn === null) {
    throw new Error("turn insert failed");
  }
  return turn;
}

export function listTurns(
  db: Db,
  conversationId: string,
  limit = 50,
): Turn[] {
  const rows = db
    .prepare(
      `SELECT * FROM turns
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(conversationId, limit) as TurnRow[];
  return rows.reverse().map(mapTurn);
}

export function recallTurns(
  db: Db,
  conversationId: string,
  range: { start: string; end: string },
  limit = 200,
): Turn[] {
  const rows = db
    .prepare(
      `SELECT * FROM turns
       WHERE conversation_id = ?
         AND created_at >= ?
         AND created_at < ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .all(conversationId, range.start, range.end, limit) as TurnRow[];
  return rows.map(mapTurn);
}

export type GlobalRecallOptions = {
  keyword?: string | null;
  limit?: number;
};

function toFtsQuery(keyword: string): string | null {
  const terms = keyword
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^a-z0-9]/g, ""))
    .filter((term) => term.length > 1);
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term}"`).join(" AND ");
}

/**
 * Memory is not scoped to one conversation: "what did I ask in November" has to
 * reach every conversation the user has ever had.
 */
export function recallTurnsEverywhere(
  db: Db,
  range: { start: string; end: string },
  options: GlobalRecallOptions = {},
): Turn[] {
  const limit = options.limit ?? 200;
  const keyword = options.keyword?.trim() ?? "";
  const ftsQuery = keyword.length > 0 ? toFtsQuery(keyword) : null;

  const filter = ftsQuery === null ? "" : "AND t.rowid IN (SELECT rowid FROM turns_fts WHERE turns_fts MATCH ?)";
  const params: unknown[] =
    ftsQuery === null
      ? [range.start, range.end, limit]
      : [range.start, range.end, ftsQuery, limit];

  const rows = db
    .prepare(
      `SELECT t.*, c.title AS conversation_title
       FROM turns t
       JOIN conversations c ON c.id = t.conversation_id
       WHERE t.created_at >= ?
         AND t.created_at < ?
         ${filter}
       ORDER BY t.created_at ASC, t.rowid ASC
       LIMIT ?`,
    )
    .all(...params) as TurnRow[];
  return rows.map(mapTurn);
}

/** The most recent turns across every conversation, newest last. */
export function recentTurnsEverywhere(db: Db, limit = 20): Turn[] {
  const rows = db
    .prepare(
      `SELECT t.*, c.title AS conversation_title
       FROM turns t
       JOIN conversations c ON c.id = t.conversation_id
       ORDER BY t.created_at DESC, t.rowid DESC
       LIMIT ?`,
    )
    .all(limit) as TurnRow[];
  return rows.reverse().map(mapTurn);
}

export type MemoryStats = {
  turns: number;
  conversations: number;
  demoConversations: number;
  firstTurnAt: string | null;
  lastTurnAt: string | null;
};

export function memoryStats(db: Db): MemoryStats {
  const turns = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS first, MAX(created_at) AS last
       FROM turns`,
    )
    .get() as { count: number; first: string | null; last: string | null };

  const conversations = db
    .prepare("SELECT COUNT(*) AS count FROM conversations")
    .get() as { count: number };

  const demo = db
    .prepare(
      "SELECT COUNT(DISTINCT conversation_id) AS count FROM turns WHERE is_demo = 1",
    )
    .get() as { count: number };

  return {
    turns: turns.count,
    conversations: conversations.count,
    demoConversations: demo.count,
    firstTurnAt: turns.first,
    lastTurnAt: turns.last,
  };
}
