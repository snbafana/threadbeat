CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  repo_web_url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  current_ref TEXT NOT NULL DEFAULT 'main',
  current_commit TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_status
  ON agents(status, created_at DESC);

CREATE TABLE IF NOT EXISTS code_storage_repos (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  code_storage_repo_id TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  source_provider TEXT,
  source_owner TEXT,
  source_name TEXT,
  source_default_branch TEXT,
  remote_url_redacted TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_code_storage_repos_agent_id
  ON code_storage_repos(agent_id);

CREATE INDEX IF NOT EXISTS idx_code_storage_repos_repo_id
  ON code_storage_repos(code_storage_repo_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'run',
  objective TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  run_branch TEXT NOT NULL,
  base_commit TEXT,
  result_commit TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  result_summary TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id
  ON agent_runs(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status
  ON agent_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'heartbeat',
  cadence_seconds INTEGER NOT NULL DEFAULT 60,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_tick TEXT,
  next_tick TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_id
  ON heartbeats(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_heartbeats_due
  ON heartbeats(status, next_tick, created_at);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'modal',
  provider_sandbox_id TEXT,
  state TEXT NOT NULL DEFAULT 'starting',
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  workdir TEXT NOT NULL DEFAULT '/workspace/agent',
  started_at TEXT,
  stopped_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sandboxes_agent_id
  ON sandboxes(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sandboxes_state
  ON sandboxes(state, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  sandbox_id TEXT,
  run_id TEXT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_agent_id
  ON messages(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sandbox_id
  ON messages(sandbox_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at DESC);
