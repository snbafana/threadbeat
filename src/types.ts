export type AgentRow = {
  id: string;
  name: string;
  repo_url: string;
  current_ref: string;
};

export type AgentRunRow = {
  id: string;
  agent_id: string;
  objective: string;
  input_ref: string;
  run_branch: string;
  result_commit: string | null;
  worker_id: string | null;
  status: string;
};

export type HostedGitRepoRow = {
  agent_id: string;
  owner: string;
  repo: string;
};

export type HeartbeatRow = {
  id: string;
  agent_id: string;
  title: string;
};

export type SandboxRow = {
  id: string;
  agent_id: string;
  run_id: string | null;
  provider_sandbox_id: string | null;
  state: string;
};

export type MessageRow = {
  agent_id: string | null;
  sandbox_id: string | null;
  run_id: string | null;
  type: string;
  text: string | null;
};
