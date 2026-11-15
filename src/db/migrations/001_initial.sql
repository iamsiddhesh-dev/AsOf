-- 001_initial.sql
-- The ledger is the memory. Claims are append-only and always carry provenance.

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model TEXT,
  latency_ms INTEGER,
  token_in INTEGER,
  token_out INTEGER,
  status TEXT NOT NULL DEFAULT 'done'
    CHECK (status IN ('streaming', 'done', 'error')),
  resolved_start TEXT,
  resolved_end TEXT,
  resolved_label TEXT,
  intent TEXT,
  claims_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (claims_status IN ('pending', 'done', 'failed', 'skipped')),
  trace_id TEXT,
  parent_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  UNIQUE (canonical_name, kind)
);

CREATE TABLE entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE,
  PRIMARY KEY (entity_id, alias)
);

CREATE TABLE entity_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE entity_set_members (
  set_id TEXT NOT NULL REFERENCES entity_sets(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (set_id, entity_id)
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE turn_topics (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  score REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_id, topic_id)
);

CREATE TABLE turn_entities (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mention TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'subject',
  PRIMARY KEY (turn_id, entity_id, mention)
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  http_status INTEGER,
  content_hash TEXT,
  snippet TEXT,
  text_excerpt TEXT,
  etag TEXT,
  last_modified TEXT,
  trust REAL NOT NULL DEFAULT 0.5 CHECK (trust >= 0 AND trust <= 1),
  provider TEXT NOT NULL
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  subject_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  subject_text TEXT NOT NULL,
  attribute TEXT NOT NULL,
  claim_type TEXT NOT NULL DEFAULT 'fact',
  value_json TEXT NOT NULL DEFAULT '{}',
  value_text TEXT,
  unit TEXT,
  currency TEXT,
  period TEXT,
  plan TEXT,
  region TEXT,
  promo INTEGER NOT NULL DEFAULT 0 CHECK (promo IN (0, 1)),
  polarity INTEGER NOT NULL DEFAULT 1 CHECK (polarity IN (-1, 1)),
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  source_kind TEXT NOT NULL DEFAULT 'web'
    CHECK (source_kind IN ('web', 'user', 'memory', 'system')),
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  quote TEXT NOT NULL CHECK (length(trim(quote)) > 0),
  observed_at TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  supersedes_claim_id TEXT REFERENCES claims(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'retracted', 'unknown')),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (turn_id, content_hash)
);

CREATE TABLE search_cache (
  key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  results_json TEXT NOT NULL
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
  claim_id TEXT REFERENCES claims(id) ON DELETE SET NULL,
  question TEXT NOT NULL,
  condition_json TEXT NOT NULL DEFAULT '{}',
  cadence_minutes INTEGER NOT NULL CHECK (cadence_minutes > 0),
  next_check_at TEXT NOT NULL,
  last_check_at TEXT,
  last_verdict TEXT
    CHECK (last_verdict IN ('same', 'changed', 'mixed', 'unknown') OR last_verdict IS NULL),
  channel TEXT NOT NULL DEFAULT 'in_app',
  quiet_start TEXT,
  quiet_end TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'expired', 'done')),
  lease_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE watch_events (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('same', 'changed', 'mixed', 'unknown')),
  old_value TEXT,
  new_value TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  notified_at TEXT
);

CREATE TABLE traces (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_turns_conversation_created
  ON turns (conversation_id, created_at);

CREATE INDEX idx_claims_subject_attribute_observed
  ON claims (subject_text, attribute, observed_at);

CREATE INDEX idx_claims_subject_entity
  ON claims (subject_entity_id);

CREATE INDEX idx_claims_conversation
  ON claims (conversation_id);

CREATE INDEX idx_sources_content_hash
  ON sources (content_hash);

CREATE INDEX idx_sources_canonical_url
  ON sources (canonical_url);

CREATE INDEX idx_watches_next_check
  ON watches (next_check_at, status);

CREATE INDEX idx_watch_events_watch
  ON watch_events (watch_id, checked_at);

CREATE INDEX idx_traces_turn
  ON traces (turn_id);

CREATE VIRTUAL TABLE turns_fts USING fts5(
  content,
  content = 'turns',
  content_rowid = 'rowid'
);

CREATE TRIGGER turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts (rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts (turns_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts (turns_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO turns_fts (rowid, content) VALUES (new.rowid, new.content);
END;
