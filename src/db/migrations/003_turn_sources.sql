-- Citations are per turn, not per response body.
-- Reopening a conversation has to show the evidence that was actually used,
-- even after the process that answered it has gone away.
CREATE TABLE turn_sources (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- The prompt-facing id, `s1`, so a stored answer can be read with its own
  -- footnote numbers intact.
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_id, label)
);

CREATE INDEX idx_turn_sources_source
  ON turn_sources (source_id);
