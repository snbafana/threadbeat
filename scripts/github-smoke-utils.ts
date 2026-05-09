import assert from "node:assert/strict";

import { resolveGitHubToken } from "../src/config.js";

export { resolveGitHubToken };

const githubHeaders = (token: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "user-agent": "threadbeat",
  "x-github-api-version": "2022-11-28",
});

export const assertCanCleanUpSmokeRepo = async (token: string, smokeName: string): Promise<void> => {
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token),
    method: "GET",
  });
  const scopes = response.headers.get("x-oauth-scopes") ?? "";
  const scopeSet = new Set(scopes.split(",").map((scope) => scope.trim()).filter(Boolean));
  if (!scopeSet.has("delete_repo")) {
    throw new Error(
      `${smokeName} requires a token with delete_repo scope so the temporary repo can be cleaned up.`,
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
