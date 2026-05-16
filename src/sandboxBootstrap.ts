type SandboxBootstrapInput = {
  baseRef?: string;
  pushRef?: boolean;
  repoUrl: string;
  ref: string;
  workdir: string;
};

type SandboxBootstrapExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type SandboxBootstrapCommandResult = SandboxBootstrapExecResult & {
  command: string[];
};

type SandboxBootstrapExec = (command: string[]) => Promise<SandboxBootstrapExecResult>;

export const buildSandboxBootstrapCommands = (input: SandboxBootstrapInput): string[][] => {
  const repoUrl = requireNonEmpty(input.repoUrl, "repoUrl");
  const ref = requireCheckoutRef(input.ref);
  const baseRef = input.baseRef === undefined ? undefined : requireCheckoutRef(input.baseRef);
  const pushRef = input.pushRef === true;
  const workdir = requireAbsoluteWorkdir(input.workdir);
  const parentDir = parentDirectory(workdir);
  const checkoutCommand = baseRef
    ? [
      "sh",
      "-lc",
      `git -C ${shellQuote(workdir)} checkout ${shellQuote(ref)} || git -C ${shellQuote(workdir)} checkout -B ${shellQuote(ref)} ${shellQuote(baseRef)}`,
    ]
    : ["git", "-C", workdir, "checkout", ref];

  const commands = [
    ["mkdir", "-p", parentDir],
    ["sh", "-lc", "command -v git >/dev/null || (apt-get update && apt-get install -y git)"],
    ["git", "clone", "--", repoUrl, workdir],
    checkoutCommand,
    ["git", "-C", workdir, "status", "--short", "--branch"],
  ];
  if (pushRef) commands.push(["git", "-C", workdir, "push", "-u", "origin", `HEAD:${ref}`]);
  return commands;
};

export const bootstrapSandbox = async (
  input: SandboxBootstrapInput,
  exec: SandboxBootstrapExec,
): Promise<SandboxBootstrapCommandResult[]> => {
  const results: SandboxBootstrapCommandResult[] = [];
  for (const command of buildSandboxBootstrapCommands(input)) {
    const result = await exec(command);
    results.push({ command, ...result });
    if (result.exitCode !== 0) {
      throw new Error(`bootstrap command failed (${result.exitCode}): ${command.join(" ")}`);
    }
  }
  return results;
};

const requireNonEmpty = (value: string, field: string): string => {
  if (value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  if (value.includes("\0")) throw new Error(`${field} must not contain null bytes`);
  return value.trim();
};

const requireCheckoutRef = (value: string): string => {
  const ref = requireNonEmpty(value, "ref");
  if (ref.startsWith("-")) throw new Error("ref must not start with '-'");
  return ref;
};

const requireAbsoluteWorkdir = (value: string): string => {
  const workdir = requireNonEmpty(value, "workdir");
  if (!workdir.startsWith("/")) throw new Error("workdir must be an absolute sandbox path");
  if (workdir === "/") throw new Error("workdir must not be the filesystem root");
  return workdir.replace(/\/+$/, "");
};

const parentDirectory = (workdir: string): string => {
  const withoutTrailingSlash = workdir.replace(/\/+$/, "");
  const lastSlash = withoutTrailingSlash.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return withoutTrailingSlash.slice(0, lastSlash);
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
