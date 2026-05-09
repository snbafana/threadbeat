export type AgentBootInput = {
  agentPiApiKeyEnv?: string;
  agentPiCommand?: string;
  agentPiModel?: string;
  agentPiProvider?: string;
  objective: string;
  promptPath?: string;
  runId: string;
  taskPath?: string;
};

export type AgentBootPlan = {
  command: string[];
  piApiKeyEnv: string;
  piCommand: string;
  piExecutable: string;
  piModel: string;
  piProvider: string;
  objective: string;
  promptPath: string;
  runId: string;
  taskPath: string;
};

export type AgentRuntimeCheckPlan = {
  command: string[];
  piCommand: string;
};

const DEFAULT_PROMPT_PATH = ".pi/prompts/heartbeat.md";

export const buildAgentBootPlan = (input: AgentBootInput): AgentBootPlan => {
  const runId = requireSafeRunId(input.runId);
  const objective = requireNonEmpty(input.objective, "objective");
  const piCommand = requireSafeShellCommand(input.agentPiCommand ?? "pi", "agentPiCommand");
  const piExecutable = firstCommandWord(piCommand);
  const piProvider = requireSafeArgument(input.agentPiProvider ?? "deepseek", "agentPiProvider");
  const piModel = requireSafeArgument(input.agentPiModel ?? "deepseek-v4-flash", "agentPiModel");
  const piApiKeyEnv = requireSafeEnvName(input.agentPiApiKeyEnv ?? "DEEPSEEK_API_KEY", "agentPiApiKeyEnv");
  const promptPath = requireSafeRelativePath(input.promptPath ?? DEFAULT_PROMPT_PATH, "promptPath");
  const taskPath = requireSafeRelativePath(input.taskPath ?? `tasks/inbox/${runId}.md`, "taskPath");
  const script = [
    `mkdir -p ${shellQuote(parentDirectory(taskPath))}`,
    `test -f ${shellQuote(promptPath)}`,
    `cat > ${shellQuote(taskPath)} <<'THREADBEAT_TASK'`,
    renderTaskFile({ objective, runId }),
    "THREADBEAT_TASK",
    `if ! command -v ${shellQuote(piExecutable)} >/dev/null 2>&1; then`,
    "  echo 'Pi CLI is not installed in this sandbox image. Install Pi in the Modal image before live agent boots.' >&2",
    "  exit 127",
    "fi",
    `if [ -z "\${${piApiKeyEnv}:-}" ]; then`,
    `  echo '${piApiKeyEnv} is not set in this sandbox. Add it to THREADBEAT_SANDBOX_ENV_ALLOWLIST and the server environment.' >&2`,
    "  exit 78",
    "fi",
    "{",
    "  printf 'Use the project instructions in AGENTS.md and the prompt template below.\\n\\n'",
    `  cat ${shellQuote(promptPath)}`,
    "  printf '\\n\\nThreadbeat run task follows. Do one bounded step, update repo files as needed, then stop.\\n\\n'",
    `  cat ${shellQuote(taskPath)}`,
    `} | ${piCommand} --provider ${shellQuote(piProvider)} --model ${shellQuote(piModel)} --api-key "$${piApiKeyEnv}" --mode json -p`,
  ].join("\n");
  return {
    command: ["bash", "-lc", script],
    piApiKeyEnv,
    piCommand,
    piExecutable,
    piModel,
    piProvider,
    objective,
    promptPath,
    runId,
    taskPath,
  };
};

export const buildAgentRuntimeCheckPlan = (input: { agentPiCommand?: string } = {}): AgentRuntimeCheckPlan => {
  const piCommand = requireSafeShellCommand(input.agentPiCommand ?? "pi", "agentPiCommand");
  const piExecutable = firstCommandWord(piCommand);
  return {
    command: ["bash", "-lc", [
      "set -e",
      "test -f AGENTS.md",
      "test -f .pi/prompts/heartbeat.md",
      "test -d .pi/skills",
      `command -v ${shellQuote(piExecutable)}`,
      `${piCommand} --help >/tmp/threadbeat-pi-help.txt 2>&1 || true`,
      "printf 'agent runtime ready\\n'",
    ].join("\n")],
    piCommand,
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

const requireSafeArgument = (value: string, field: string): string => {
  const argument = requireNonEmpty(value, field);
  if (/[\n\r\0]/.test(argument)) throw new Error(`${field} must be a single command argument`);
  return argument;
};

const requireSafeEnvName = (value: string, field: string): string => {
  const name = requireNonEmpty(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${field} must be a shell env variable name`);
  return name;
};

const firstCommandWord = (command: string): string => {
  const [word] = command.trim().split(/\s+/);
  if (!word) throw new Error("agentPiCommand must start with an executable");
  if (word.includes("'") || word.includes("\"")) throw new Error("agentPiCommand executable must not be quoted");
  return word;
};

const parentDirectory = (value: string): string => {
  const lastSlash = value.lastIndexOf("/");
  return lastSlash < 0 ? "." : value.slice(0, lastSlash);
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
