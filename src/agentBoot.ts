export type AgentBootInput = {
  agentPiCommand?: string;
  objective: string;
  promptPath?: string;
  runId: string;
  taskPath?: string;
};

export type AgentBootPlan = {
  command: string[];
  piCommand: string;
  objective: string;
  promptPath: string;
  runId: string;
  taskPath: string;
};

const DEFAULT_PROMPT_PATH = ".pi/prompts/heartbeat.md";

export const buildAgentBootPlan = (input: AgentBootInput): AgentBootPlan => {
  const runId = requireSafeRunId(input.runId);
  const objective = requireNonEmpty(input.objective, "objective");
  const piCommand = requireSafeShellCommand(input.agentPiCommand ?? "pi", "agentPiCommand");
  const promptPath = requireSafeRelativePath(input.promptPath ?? DEFAULT_PROMPT_PATH, "promptPath");
  const taskPath = requireSafeRelativePath(input.taskPath ?? `tasks/inbox/${runId}.md`, "taskPath");
  const script = [
    `mkdir -p ${shellQuote(parentDirectory(taskPath))}`,
    `cat > ${shellQuote(taskPath)} <<'THREADBEAT_TASK'`,
    renderTaskFile({ objective, runId }),
    "THREADBEAT_TASK",
    "if ! command -v pi >/dev/null 2>&1; then",
    "  echo 'Pi CLI is not installed in this sandbox image. Install Pi in the Modal image before live agent boots.' >&2",
    "  exit 127",
    "fi",
    `${piCommand} --prompt-file ${shellQuote(promptPath)} --message-file ${shellQuote(taskPath)}`,
  ].join("\n");
  return {
    command: ["bash", "-lc", script],
    piCommand,
    objective,
    promptPath,
    runId,
    taskPath,
  };
};

const renderTaskFile = ({ objective, runId }: { objective: string; runId: string }): string => `# Threadbeat Run Task

Run ID: ${runId}

## Objective

${objective}
`;

const requireNonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  if (trimmed.includes("\0")) throw new Error(`${field} must not contain null bytes`);
  return trimmed;
};

const requireSafeRunId = (value: string): string => {
  const runId = requireNonEmpty(value, "runId");
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error("runId contains unsafe path characters");
  return runId;
};

const requireSafeRelativePath = (value: string, field: string): string => {
  const path = requireNonEmpty(value, field).replace(/\\/g, "/");
  if (path.startsWith("/") || path.includes("://")) throw new Error(`${field} must be a relative repo path`);
  if (path.split("/").some((part) => part === ".." || part === "")) throw new Error(`${field} must be a safe relative path`);
  return path;
};

const requireSafeShellCommand = (value: string, field: string): string => {
  const command = requireNonEmpty(value, field);
  if (/[\n\r\0]/.test(command)) throw new Error(`${field} must be a single shell command line`);
  return command;
};

const parentDirectory = (value: string): string => {
  const lastSlash = value.lastIndexOf("/");
  return lastSlash < 0 ? "." : value.slice(0, lastSlash);
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
