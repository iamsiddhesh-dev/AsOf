import type { Db } from "../db/index.js";

export type ClaimStatus = "active" | "superseded" | "retracted" | "unknown";

/** How many claims this conversation currently stands behind. */
export function countClaims(
  db: Db,
  conversationId: string,
  status: ClaimStatus = "active",
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM claims
       WHERE conversation_id = ? AND status = ?`,
    )
    .get(conversationId, status) as { count: number } | undefined;
  return row?.count ?? 0;
}
