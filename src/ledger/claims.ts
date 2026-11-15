import type { Db } from "../db/index.js";

export type ClaimStatus = "active" | "superseded" | "retracted" | "unknown";

export type CountClaimsOptions = {
  /** Omit to count the whole ledger. Memory is not scoped to one conversation. */
  conversationId?: string | null;
  status?: ClaimStatus;
};

/** How many claims the ledger currently stands behind. */
export function countClaims(db: Db, options: CountClaimsOptions = {}): number {
  const status = options.status ?? "active";
  const conversationId = options.conversationId ?? null;

  const row =
    conversationId === null
      ? (db
          .prepare("SELECT COUNT(*) AS count FROM claims WHERE status = ?")
          .get(status) as { count: number } | undefined)
      : (db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM claims
             WHERE conversation_id = ? AND status = ?`,
          )
          .get(conversationId, status) as { count: number } | undefined);

  return row?.count ?? 0;
}
