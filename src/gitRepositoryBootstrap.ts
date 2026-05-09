import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentTemplateFile } from "./agentTemplate.js";

const execFileAsync = promisify(execFile);

export type InitialCommitInput = {
  authorEmail?: string;
  authorName?: string;
  branch: string;
  commitMessage?: string;
  files: AgentTemplateFile[];
  remoteUrl: string;
};

export type InitialCommitResult = {
  branch: string;
  commitSha: string;
  filesWritten: string[];
  statusText: string;
};

export const createInitialCommit = async (input: InitialCommitInput): Promise<InitialCommitResult> => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-agent-repo-"));
  try {
    const repoDir = path.join(tempRoot, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    const filesWritten = await writeTemplateFiles(repoDir, input.files);
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.name", input.authorName ?? "Threadbeat"]);
    await git(repoDir, ["config", "user.email", input.authorEmail ?? "threadbeat@example.local"]);
    await git(repoDir, ["checkout", "-B", input.branch]);
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-m", input.commitMessage ?? "Initialize agent template"]);
    const commitSha = (await git(repoDir, ["rev-parse", "HEAD"])).trim();
    const statusText = await git(repoDir, ["status", "--short", "--branch"]);
    await git(repoDir, ["remote", "add", "origin", input.remoteUrl]);
    await git(repoDir, ["push", "-u", "origin", `HEAD:${input.branch}`]);
    return {
      branch: input.branch,
      commitSha,
      filesWritten,
      statusText,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
};

export const writeTemplateFiles = async (root: string, files: AgentTemplateFile[]): Promise<string[]> => {
  const written: string[] = [];
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error(`unsafe template path: ${file.path}`);
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
    written.push(file.path);
  }
  return written;
};

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout || stderr;
};

const isSafeRelativePath = (value: string): boolean =>
  value !== "" && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
