import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitHubOwnerType = "auto" | "org" | "user";

export const parseGitHubOwnerType = (value: string): GitHubOwnerType => {
  if (value === "auto" || value === "org" || value === "user") return value;
  throw new Error("THREADBEAT_GITHUB_OWNER_TYPE must be auto, org, or user");
};

export const githubHeaders = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "user-agent": "threadbeat",
  "x-github-api-version": "2022-11-28",
});

export const resolveGitHubToken = async (): Promise<string | undefined> => {
  const envToken = process.env.THREADBEAT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  if (envToken?.trim()) return envToken.trim();
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { maxBuffer: 1024 * 1024 });
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
};

export const assertCanCleanUpSmokeRepo = async (token: string, smokeName: string): Promise<void> => {
  if (process.env.THREADBEAT_GITHUB_LIVE_SMOKE_KEEP === "1") return;
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token),
    method: "GET",
  });
  const scopes = response.headers.get("x-oauth-scopes") ?? "";
  const scopeSet = new Set(scopes.split(",").map((scope) => scope.trim()).filter(Boolean));
  if (!scopeSet.has("delete_repo")) {
    throw new Error(
      `${smokeName} requires a token with delete_repo scope so the temporary repo can be cleaned up. `
      + "Set THREADBEAT_GITHUB_LIVE_SMOKE_KEEP=1 to intentionally keep the repo.",
    );
  }
};

export const deleteGitHubRepo = async (token: string, repoPath: string): Promise<void> => {
  const response = await fetch(`https://api.github.com/repos/${repoPath}`, {
    headers: githubHeaders(token),
    method: "DELETE",
  });
  assert.equal(response.status, 204, `GitHub smoke repo delete failed (${response.status}): ${await response.text()}`);
};

export const getGitHubFile = async (token: string, repoPath: string, filePath: string): Promise<string> => {
  const response = await fetch(`https://api.github.com/repos/${repoPath}/contents/${filePath}`, {
    headers: githubHeaders(token),
  });
  if (response.status !== 200) {
    throw new Error(`GitHub file read failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json() as { content?: string; encoding?: string };
  assert.equal(body.encoding, "base64");
  assert.ok(body.content);
  return Buffer.from(body.content, "base64").toString("utf8");
};

export const githubRepoPathFromRemoteUrl = (remoteUrl: string | null): string => {
  if (!remoteUrl) throw new Error("GitHub smoke did not return a remote URL");
  const parsed = new URL(remoteUrl);
  return parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
};
