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
  return {
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
  };
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
  model?: string | null;
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
         resolved_start, resolved_end, resolved_label, status,
         claims_status, parent_turn_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', 'pending', ?)`,
    ).run(
      id,
      input.conversationId,
      input.role,
      input.content,
      createdAt,
      input.model ?? null,
      input.resolvedStart ?? null,
      input.resolvedEnd ?? null,
      input.resolvedLabel ?? null,
      input.parentTurnId ?? null,
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
