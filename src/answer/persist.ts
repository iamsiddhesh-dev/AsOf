import { extractClaims, type ClaimExtractionResult } from "../claims/extract.js";
import { upsertSources } from "../claims/store.js";
import {
  appendTurn,
  setTurnClaimsStatus,
  type Turn,
} from "../conversations/repository.js";
import type { Db } from "../db/index.js";
import { attachTurnSources } from "../ledger/turn-sources.js";
import type { ChatClient } from "../providers/types.js";
import { applyClaimUpdates } from "../recheck/compare.js";
import type { RouteDecision } from "../router/classify.js";
import type { AnswerResult } from "./answer.js";

export type ClaimsStatus = "done" | "failed" | "skipped";

export type PersistDeps = {
  clock: () => Date;
  /** The search provider name is recorded on every source row. */
  searchProvider: string;
  extractChat: ChatClient | null;
  extractModel: string;
};

export type PersistInput = {
  conversationId: string;
  text: string;
  decision: RouteDecision;
  /** When the question was asked; the answer turn is stamped at completion. */
  now: Date;
};

export type PersistedAnswer = {
  userTurn: Turn;
  assistantTurn: Turn;
  claims: ClaimExtractionResult;
  claimsStatus: ClaimsStatus;
};

const EMPTY_CLAIMS: ClaimExtractionResult = {
  inserted: 0,
  superseded: 0,
  dropped: 0,
  reason: null,
};

/**
 * Records the question on its own. Used when the answer never arrived: the
 * user did ask it, and losing the question would make the ledger lie.
 */
export function appendQuestion(db: Db, input: PersistInput): Turn {
  return appendTurn(db, {
    conversationId: input.conversationId,
    role: "user",
    content: input.text,
    createdAt: input.now.toISOString(),
    resolvedStart: input.decision.timeRange?.start ?? null,
    resolvedEnd: input.decision.timeRange?.end ?? null,
    resolvedLabel: input.decision.timeRange?.label ?? null,
    intent: input.decision.intent,
  });
}

/**
 * Writes both turns and then the claims, in that order: a claim points at the
 * assistant turn that reported it. Shared by `/ask` and `/ask/stream` so the
 * two endpoints cannot drift on what gets stored.
 *
 * A claims-mode recheck already compared and wrote what it found, so extracting
 * the same answer again would only duplicate the claims it just superseded.
 */
export async function persistAnswer(
  db: Db,
  result: AnswerResult,
  input: PersistInput,
  deps: PersistDeps,
): Promise<PersistedAnswer> {
  const userTurn = appendQuestion(db, input);

  const assistantTurn = appendTurn(db, {
    conversationId: input.conversationId,
    role: "assistant",
    content: result.answer,
    createdAt: deps.clock().toISOString(),
    parentTurnId: userTurn.id,
    intent: input.decision.intent,
    model: result.model,
    latencyMs: result.latencyMs,
    tokenIn: result.tokenIn,
    tokenOut: result.tokenOut,
  });

  let claims: ClaimExtractionResult = { ...EMPTY_CLAIMS };
  let claimsStatus: ClaimsStatus = "skipped";

  // The citations are stored against the turn before anything else touches
  // them, so reopening this conversation can still show the evidence. Claim
  // extraction below re-upserts the same source rows; the id is a content
  // hash, so that is an update, not a duplicate.
  if (result.citations.length > 0) {
    const stored = upsertSources(
      db,
      result.citations,
      deps.searchProvider,
      deps.clock().toISOString(),
    );

    attachTurnSources(
      db,
      assistantTurn.id,
      result.citations.flatMap((citation) => {
        const sourceRowId = stored.get(citation.id);
        return sourceRowId === undefined
          ? []
          : [{ label: citation.id, sourceRowId }];
      }),
    );
  }

  if (result.recheck !== null) {
    let applyError: string | null = null;

    if (result.claimUpdates.length > 0) {
      try {
        const applied = applyClaimUpdates(db, result.claimUpdates, {
          turnId: assistantTurn.id,
          conversationId: input.conversationId,
          now: deps.clock(),
        });
        claims = {
          inserted: applied.inserted,
          superseded: applied.superseded,
          dropped: 0,
          reason: null,
        };
      } catch (error) {
        applyError = (error as Error).message;
      }
    }

    if (applyError !== null) {
      claims = { ...claims, reason: applyError };
      claimsStatus = "failed";
    } else if (result.recheck.status === "done") {
      claimsStatus = "done";
    } else {
      claims = { ...claims, reason: "recheck did not compare any claims" };
    }
  } else if (result.grounded === true && result.citations.length > 0) {
    if (deps.extractChat === null) {
      claims = {
        ...EMPTY_CLAIMS,
        reason: "extraction provider is not configured",
      };
      claimsStatus = "failed";
    } else {
      try {
        claims = await extractClaims(
          db,
          { chat: deps.extractChat, model: deps.extractModel },
          {
            answer: result.answer,
            sources: result.citations,
            turnId: assistantTurn.id,
            conversationId: input.conversationId,
            now: deps.clock(),
            provider: deps.searchProvider,
          },
        );
        claimsStatus = "done";
      } catch (error) {
        claims = { ...EMPTY_CLAIMS, reason: (error as Error).message };
        claimsStatus = "failed";
      }
    }
  } else {
    claims = { ...EMPTY_CLAIMS, reason: "answer was not grounded" };
  }

  setTurnClaimsStatus(db, assistantTurn.id, claimsStatus);

  return { userTurn, assistantTurn, claims, claimsStatus };
}
