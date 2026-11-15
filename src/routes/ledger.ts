import { Hono } from "hono";
import type { Db } from "../db/index.js";
import {
  claimHistory,
  getClaim,
  listClaims,
  listSubjects,
  type ClaimStatusFilter,
} from "../ledger/read.js";

const STATUSES: readonly ClaimStatusFilter[] = [
  "active",
  "superseded",
  "retracted",
  "unknown",
  "all",
];

function parseLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 200 ? value : null;
}

function parseOffset(raw: string | undefined): number | null {
  if (raw === undefined) {
    return 0;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Read-only views of the ledger. These exist so the UI can reopen a
 * conversation and still show its evidence and claim history; before this,
 * citations only lived in the response body of the answer that produced them.
 */
export function ledgerRoutes(db: Db) {
  const router = new Hono();

  router.get("/claims", (c) => {
    const statusRaw = c.req.query("status") ?? "active";
    if (!STATUSES.includes(statusRaw as ClaimStatusFilter)) {
      return c.json(
        { error: `status must be one of ${STATUSES.join(", ")}` },
        400,
      );
    }

    const limit = parseLimit(c.req.query("limit"), 50);
    if (limit === null) {
      return c.json({ error: "limit must be an integer from 1 to 200" }, 400);
    }

    const offset = parseOffset(c.req.query("offset"));
    if (offset === null) {
      return c.json({ error: "offset must be a non-negative integer" }, 400);
    }

    const subject = c.req.query("subject") ?? null;
    if (subject !== null && subject.length > 200) {
      return c.json({ error: "subject is too long" }, 400);
    }

    const query = c.req.query("q") ?? null;
    if (query !== null && query.length > 200) {
      return c.json({ error: "q is too long" }, 400);
    }

    return c.json(
      listClaims(db, {
        status: statusRaw as ClaimStatusFilter,
        subject,
        query,
        limit,
        offset,
      }),
    );
  });

  router.get("/subjects", (c) => {
    const limit = parseLimit(c.req.query("limit"), 100);
    if (limit === null) {
      return c.json({ error: "limit must be an integer from 1 to 200" }, 400);
    }
    return c.json({ subjects: listSubjects(db, limit) });
  });

  router.get("/claims/:id", (c) => {
    const id = c.req.param("id") ?? "";
    const claim = getClaim(db, id);
    if (claim === null) {
      return c.json({ error: "claim not found" }, 404);
    }
    return c.json({ claim, history: claimHistory(db, id) });
  });

  return router;
}
