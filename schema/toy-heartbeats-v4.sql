PRAGMA defer_foreign_keys = on;

CREATE TABLE heartbeats_v4 (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'heartbeat',
  cadence INTEGER NOT NULL DEFAULT 60,
  contents TEXT NOT NULL,
  last_tick TEXT,
  next_tick TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO heartbeats_v4 (
  id,
  session_id,
  title,
  cadence,
  contents,
  last_tick,
  next_tick,
  status,
  created_at,
  updated_at
)
SELECT
  id,
  session_id,
  COALESCE(title, 'heartbeat'),
  COALESCE(cadence_seconds, 60),
  CASE
    WHEN prompt LIKE '%.md' THEN prompt
    ELSE 'contents/default.md'
  END,
  last_tick_at,
  next_tick_at,
  CASE
    WHEN status = 'active' THEN 'active'
    ELSE 'inactive'
  END,
  created_at,
  updated_at
FROM heartbeats;

DROP TABLE heartbeats;

ALTER TABLE heartbeats_v4 RENAME TO heartbeats;

CREATE INDEX idx_heartbeats_session_id ON heartbeats(session_id);
