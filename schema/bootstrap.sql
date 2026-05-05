CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS heartbeats (
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

CREATE INDEX IF NOT EXISTS idx_heartbeats_session_id
  ON heartbeats(session_id);

CREATE INDEX IF NOT EXISTS idx_heartbeats_due
  ON heartbeats(status, next_tick, created_at);

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

CREATE TABLE IF NOT EXISTS heartbeat_events (
  id TEXT PRIMARY KEY,
  heartbeat_id TEXT,
  run_id TEXT,
  session_id TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_events_heartbeat_id
  ON heartbeat_events(heartbeat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_heartbeat_events_run_id
  ON heartbeat_events(run_id, created_at DESC);
