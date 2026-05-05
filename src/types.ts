export type HeartbeatStatus = "active" | "inactive";
export type RunStatus = "succeeded" | "failed" | "skipped";

export type SessionRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type HeartbeatRow = {
  id: string;
  session_id: string;
  title: string;
  cadence: number;
  contents: string;
  last_tick: string | null;
  next_tick: string | null;
  status: HeartbeatStatus;
  created_at: string;
  updated_at: string;
};

export type HeartbeatRunRow = {
  id: string;
  heartbeat_id: string;
  session_id: string;
  executor: string;
  model: string | null;
  status: RunStatus;
  prompt_snapshot: string;
  output: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type HeartbeatEventRow = {
  id: string;
  heartbeat_id: string | null;
  run_id: string | null;
  session_id: string | null;
  source: string;
  type: string;
  message: string | null;
  data: string | null;
  created_at: string;
};
