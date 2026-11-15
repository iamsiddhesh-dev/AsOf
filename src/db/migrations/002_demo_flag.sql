-- Demo history is only written by an explicit request, never on boot.
-- Seeded turns are marked so recall can label them instead of passing them off as the user's own words.
ALTER TABLE turns
  ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));

CREATE INDEX idx_turns_demo
  ON turns (is_demo)
  WHERE is_demo = 1;
