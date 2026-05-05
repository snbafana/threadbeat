CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  executor TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  prompt_snapshot TEXT NOT NULL,
  output TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_heartbeat_id
  ON heartbeat_runs(heartbeat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_session_id
  ON heartbeat_runs(session_id, created_at DESC);
