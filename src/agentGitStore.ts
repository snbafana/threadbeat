import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_BRANCH = "main";
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export type GitCommandResult = {
  args: string[];
  cwd: string;
  stderr: string;
  stdout: string;
};

export class GitCommandError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    message: string,
    options: {
      args: string[];
      cwd: string;
      exitCode: number | null;
      stderr: string;
      stdout: string;
    },
  ) {
    super(message);
    this.name = "GitCommandError";
    this.args = options.args;
    this.cwd = options.cwd;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
    this.stdout = options.stdout;
  }
}

export type AgentRepoState = {
  currentBranch: string | null;
  initialized: boolean;
  repoPath: string;
};

export type CommitAllResult =
  | {
      hash: string;
      status: "committed";
    }
  | {
      hash: string | null;
      reason: "no_changes";
      status: "noop";
    };

export type CreateRunBranchOptions = {
  fromBranch: string;
  now?: Date;
  objectiveSlug?: string;
  runId?: string;
};

export type CreateEditBranchOptions = {
  fromBranch: string;
  now?: Date;
  objectiveSlug?: string;
  toBranch: string;
};

export type MergeBranchToNewVersionOptions = {
  sourceBranch: string;
  targetVersionBranch: string;
};

export type MergeBranchToNewVersionResult = {
  hash: string;
  sourceBranch: string;
  status: "created" | "merged" | "up_to_date";
  targetVersionBranch: string;
};

export const runGit = async (
  repoPath: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<GitCommandResult> => {
  const cwd = path.resolve(repoPath);
  const gitArgs = [
    "-C",
    cwd,
    "-c",
    "core.pager=cat",
    "-c",
    "credential.interactive=false",
    ...args,
  ];
  const env = {
    ...process.env,
    GIT_EDITOR: ":",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      gitArgs,
      {
        encoding: "utf8",
        env,
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: options.timeoutMs ?? 30_000,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error) {
          reject(
            new GitCommandError(`git ${args.join(" ")} failed`, {
              args,
              cwd,
              exitCode: typeof error.code === "number" ? error.code : null,
              stderr,
              stdout,
            }),
          );
          return;
        }
        resolve({ args, cwd, stderr, stdout });
      },
    );
  });
};

export const ensureAgentRepo = async (
  repoPath: string,
  options: { initialBranch?: string } = {},
): Promise<AgentRepoState> => {
  const resolvedRepoPath = path.resolve(repoPath);
  const initialBranch = normalizeBranchName(options.initialBranch ?? DEFAULT_BRANCH, "main");
  await fs.mkdir(resolvedRepoPath, { recursive: true });

  const initialized = !(await hasGitDir(resolvedRepoPath));
  if (initialized) {
    await runGit(resolvedRepoPath, ["init", "-b", initialBranch]);
  }

  return {
    currentBranch: await currentBranch(resolvedRepoPath),
    initialized,
    repoPath: resolvedRepoPath,
  };
};

export const normalizeBranchName = (
  value: string,
  fallback = "branch",
  options: { maxLength?: number } = {},
): string => {
  const maxLength = options.maxLength ?? 160;
  const asciiValue = Array.from(value.normalize("NFKD"))
    .filter((char) => char.charCodeAt(0) <= 0x7f)
    .join("");
  const normalized = asciiValue
    .toLowerCase()
    .trim()
    .replace(/@{/g, "_")
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/\.{2,}/g, "_");

  return finalizeBranchSegment(normalized, fallback, maxLength);
};

export const createAgentVersionBranch = async (
  repoPath: string,
  versionBranch: string,
): Promise<string> => {
  await ensureAgentRepo(repoPath);
  const branch = normalizeBranchRef(versionBranch, "agent_version");
  const current = await currentBranch(repoPath);
  if (current === branch) return branch;

  if (await localBranchExists(repoPath, branch)) {
    await runGit(repoPath, ["switch", branch]);
    return branch;
  }

  await runGit(repoPath, ["switch", "-c", branch]);
  return branch;
};

export const createRunBranch = async (
  repoPath: string,
  options: CreateRunBranchOptions,
): Promise<string> => {
  await ensureAgentRepo(repoPath);
  const fromBranch = normalizeBranchRef(options.fromBranch, "agent");
  const slug = normalizeBranchName(options.objectiveSlug ?? options.runId ?? "run", "run", {
    maxLength: 48,
  });
  const fromSegment = normalizeBranchName(fromBranch, "agent", { maxLength: 64 });
  const branch = finalizeBranchSegment(
    `run_${timestampBranchSegment(options.now).toLowerCase()}_${slug}__from_${fromSegment}`,
    "run",
    160,
  );
  await switchToNewBranch(repoPath, branch, fromBranch);
  return branch;
};

export const createEditBranch = async (
  repoPath: string,
  options: CreateEditBranchOptions,
): Promise<string> => {
  await ensureAgentRepo(repoPath);
  const fromBranch = normalizeBranchRef(options.fromBranch, "from");
  const toBranch = normalizeBranchRef(options.toBranch, "to");
  const slug = normalizeBranchName(options.objectiveSlug ?? "edit", "edit", { maxLength: 48 });
  const fromSegment = normalizeBranchName(fromBranch, "from", { maxLength: 56 });
  const toSegment = normalizeBranchName(toBranch, "to", { maxLength: 56 });
  const branch = finalizeBranchSegment(
    `edit_${timestampBranchSegment(options.now).toLowerCase()}_${slug}__${fromSegment}_to_${toSegment}`,
    "edit",
    160,
  );
  await switchToNewBranch(repoPath, branch, fromBranch);
  return branch;
};

export const commitAll = async (repoPath: string, message: string): Promise<CommitAllResult> => {
  await ensureAgentRepo(repoPath);
  const trimmedMessage = message.trim();
  if (!trimmedMessage) throw new Error("commit message is required");

  await runGit(repoPath, ["add", "-A"]);
  const status = await runGit(repoPath, ["status", "--porcelain=v1"]);
  if (!status.stdout.trim()) {
    return {
      hash: await currentCommit(repoPath),
      reason: "no_changes",
      status: "noop",
    };
  }

  await runGit(repoPath, ["commit", "--no-gpg-sign", "--message", trimmedMessage]);
  const hash = await currentCommit(repoPath);
  if (!hash) throw new Error("commit succeeded but HEAD could not be resolved");
  return { hash, status: "committed" };
};

export const mergeBranchToNewVersion = async (
  repoPath: string,
  options: MergeBranchToNewVersionOptions,
): Promise<MergeBranchToNewVersionResult> => {
  await ensureAgentRepo(repoPath);
  const sourceBranch = normalizeBranchRef(options.sourceBranch, "source");
  const targetVersionBranch = normalizeBranchRef(options.targetVersionBranch, "target_version");

  if (!(await localBranchExists(repoPath, sourceBranch))) {
    throw new Error(`source branch does not exist: ${sourceBranch}`);
  }

  if (!(await localBranchExists(repoPath, targetVersionBranch))) {
    await runGit(repoPath, ["switch", "-c", targetVersionBranch, sourceBranch]);
    const hash = await currentCommit(repoPath, targetVersionBranch);
    if (!hash) throw new Error(`target branch has no commit: ${targetVersionBranch}`);
    return { hash, sourceBranch, status: "created", targetVersionBranch };
  }

  await runGit(repoPath, ["switch", targetVersionBranch]);
  const beforeHash = await currentCommit(repoPath);
  await runGit(repoPath, [
    "merge",
    "--no-ff",
    "--no-edit",
    "--no-gpg-sign",
    sourceBranch,
  ]);
  const hash = await currentCommit(repoPath);
  if (!hash) throw new Error(`target branch has no commit: ${targetVersionBranch}`);
  return {
    hash,
    sourceBranch,
    status: beforeHash === hash ? "up_to_date" : "merged",
    targetVersionBranch,
  };
};

export const diff = async (
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<string> => {
  await ensureAgentRepo(repoPath);
  assertSafeRef(fromRef);
  assertSafeRef(toRef);
  const result = await runGit(repoPath, ["diff", "--patch", fromRef, toRef, "--"]);
  return result.stdout;
};

export const currentCommit = async (
  repoPath: string,
  ref = "HEAD",
): Promise<string | null> => {
  await ensureAgentRepo(repoPath);
  assertSafeRef(ref);
  try {
    const result = await runGit(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
};

export const currentBranch = async (repoPath: string): Promise<string | null> => {
  try {
    const result = await runGit(repoPath, ["symbolic-ref", "--short", "HEAD"]);
    return result.stdout.trim() || null;
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
};

export const localBranchExists = async (
  repoPath: string,
  branch: string,
): Promise<boolean> => {
  const normalizedBranch = normalizeBranchRef(branch);
  try {
    await runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${normalizedBranch}`]);
    return true;
  } catch (error) {
    if (error instanceof GitCommandError) return false;
    throw error;
  }
};

export const normalizeBranchRef = (
  value: string,
  fallback = "branch",
  options: { maxLength?: number } = {},
): string => {
  const normalizedPath = value
    .split("/")
    .map((part) => normalizeBranchName(part, fallback, options))
    .filter((part) => part.length > 0)
    .join("/");

  return normalizedPath || normalizeBranchName(fallback, "branch", options);
};

const switchToNewBranch = async (
  repoPath: string,
  branch: string,
  fromBranch: string,
): Promise<void> => {
  if (await localBranchExists(repoPath, branch)) {
    throw new Error(`branch already exists: ${branch}`);
  }
  await runGit(repoPath, ["switch", "-c", branch, fromBranch]);
};

const hasGitDir = async (repoPath: string): Promise<boolean> => {
  try {
    await fs.lstat(path.join(repoPath, ".git"));
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
};

const timestampBranchSegment = (date = new Date()): string =>
  date.toISOString().replace(/[-:.]/g, "");

const finalizeBranchSegment = (value: string, fallback: string, maxLength: number): string => {
  let cleaned = value.slice(0, maxLength).replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  if (!cleaned) cleaned = fallback;
  if (cleaned === "@") cleaned = fallback;
  if (cleaned.endsWith(".lock")) cleaned = `${cleaned.slice(0, -5)}_lock`;
  return cleaned || fallback;
};

const assertSafeRef = (ref: string): void => {
  if (!ref.trim()) throw new Error("git ref is required");
  if (ref.startsWith("-")) throw new Error(`git ref must not start with '-': ${ref}`);
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;
