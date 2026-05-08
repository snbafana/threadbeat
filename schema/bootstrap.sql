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
  provider TEXT NOT NULL DEFAULT 'deepseek',
  model TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
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

CREATE INDEX IF NOT EXISTS idx_heartbeat_events_session_id
  ON heartbeat_events(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_heartbeat_events_created_at
  ON heartbeat_events(created_at DESC);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  current_version TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_status
  ON agents(status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'edit')),
  input_branch TEXT NOT NULL,
  run_branch TEXT NOT NULL,
  output_branch TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  objective TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id
  ON agent_runs(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status
  ON agent_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  message TEXT,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_events_agent_id
  ON agent_events(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_events_run_id
  ON agent_events(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_events_created_at
  ON agent_events(created_at DESC);
