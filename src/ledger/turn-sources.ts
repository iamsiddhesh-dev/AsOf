import type { Db } from "../db/index.js";

/**
 * A citation as it was handed to the model, re-attached to the turn that used
 * it. The label is the `s1` the answer cites; the rest is the evidence.
 */
export type TurnSource = {
  label: string;
  position: number;
  id: string;
  title: string | null;
  url: string;
  domain: string;
  publishedAt: string | null;
  fetchedAt: string;
  snippet: string | null;
};

type TurnSourceRow = {
  label: string;
  position: number;
  id: string;
  title: string | null;
  url: string;
  domain: string;
  published_at: string | null;
  fetched_at: string;
  snippet: string | null;
};

export function attachTurnSources(
  db: Db,
  turnId: string,
  sources: Array<{ label: string; sourceRowId: string }>,
): void {
  const insert = db.prepare(
    `INSERT INTO turn_sources (turn_id, source_id, label, position)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(turn_id, label) DO UPDATE SET
       source_id = excluded.source_id,
       position = excluded.position`,
  );

  const attach = db.transaction(() => {
    sources.forEach((source, index) => {
      insert.run(turnId, source.sourceRowId, source.label, index);
    });
  });

  attach();
}

export function listTurnSources(db: Db, turnId: string): TurnSource[] {
  const rows = db
    .prepare(
      `SELECT ts.label, ts.position, s.id, s.title, s.url, s.domain,
              s.published_at, s.fetched_at, s.snippet
       FROM turn_sources ts
       JOIN sources s ON s.id = ts.source_id
       WHERE ts.turn_id = ?
       ORDER BY ts.position ASC`,
    )
    .all(turnId) as TurnSourceRow[];

  return rows.map((row) => ({
    label: row.label,
    position: row.position,
    id: row.id,
    title: row.title,
    url: row.url,
    domain: row.domain,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    snippet: row.snippet,
  }));
}
