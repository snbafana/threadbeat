CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  current_ref TEXT NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS hosted_git_repos (
  agent_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  run_branch TEXT NOT NULL,
  result_commit TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'heartbeat',
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  provider_sandbox_id TEXT,
  state TEXT NOT NULL DEFAULT 'starting',
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS messages (
  agent_id TEXT,
  sandbox_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  text TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE SET NULL
);
