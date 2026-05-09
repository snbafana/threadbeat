export type AgentRow = {
  id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  current_ref: string;
  status: string;
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
