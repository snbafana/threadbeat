export type AgentRow = {
  id: string;
  name: string;
  repo_url: string;
  repo_web_url: string | null;
  default_branch: string;
  current_ref: string;
  current_commit: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type AgentRunRow = {
  id: string;
  agent_id: string;
  kind: string;
  objective: string;
  input_ref: string;
  run_branch: string;
  base_commit: string | null;
  result_commit: string | null;
  status: string;
  result_summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type HeartbeatRow = {
  id: string;
  agent_id: string;
  title: string;
  cadence_seconds: number;
  action: string;
  status: string;
  last_tick: string | null;
  next_tick: string | null;
  created_at: string;
  updated_at: string;
};

export type SandboxRow = {
  id: string;
  agent_id: string;
  provider: string;
  provider_sandbox_id: string | null;
  state: string;
  repo_url: string;
  branch: string;
  workdir: string;
  started_at: string | null;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  agent_id: string | null;
  sandbox_id: string | null;
  run_id: string | null;
  source: string;
  type: string;
  text: string | null;
  data_json: string | null;
  created_at: string;
};
