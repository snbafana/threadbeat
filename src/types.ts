export type TaskStatus = "queued" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

export type RunStatus = "running" | "succeeded" | "failed";

export type EventSource = "api" | "worker" | "daytona" | "command";

export type EventType =
  | "task_created"
  | "task_claimed"
  | "run_started"
  | "sandbox_created"
  | "repo_clone_started"
  | "repo_clone_finished"
  | "phase_started"
  | "command_started"
  | "command_stdout"
  | "command_finished"
  | "run_succeeded"
  | "run_failed"
  | "sandbox_deleted";

export type TaskSpec = {
  repo?: RepoSpec;
  setup?: CommandSpec[];
  main: CommandSpec;
  verify?: CommandSpec[];
};

export type RepoSpec = {
  url: string;
  branch?: string;
  commit?: string;
};

export type CommandSpec = {
  cmd: string;
  cwd?: string;
  timeoutSeconds?: number;
};

export type TaskRow = {
  id: string;
  status: TaskStatus;
  spec: TaskSpec;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type RunRow = {
  id: string;
  taskId: string;
  status: RunStatus;
  sandboxId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type EventRow = {
  id: string;
  seq: number;
  taskId: string;
  runId: string | null;
  type: EventType;
  source: EventSource;
  message: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
};

export type CreateTaskInput = {
  spec: TaskSpec;
};

export type AppendEventInput = {
  taskId: string;
  runId?: string | null;
  type: EventType;
  source: EventSource;
  message?: string | null;
  data?: Record<string, unknown> | null;
};

export const WORKSPACE_DIR = "workspace";
export const REPO_DIR = "workspace/repo";
