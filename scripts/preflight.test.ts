import assert from "node:assert/strict";

import type { Settings } from "../src/config.js";
import { buildPreflightReport } from "../src/preflight.js";

const baseSettings: Settings = {
  projectRoot: ".",
  dbUrl: "file::memory:",
  host: "127.0.0.1",
  port: 0,
  modalMode: "live",
  modalAppName: "threadbeat-test",
  modalImage: "python:3.13-slim",
  modalInstallSandboxPi: true,
  sandboxEnv: { OPENAI_API_KEY: "sk-test" },
  sandboxEnvNames: ["OPENAI_API_KEY"],
  sandboxExecTimeoutMs: 120_000,
  agentBootTimeoutMs: 600_000,
  hostedGitProvider: "github",
  githubOwner: "snbafana",
  githubToken: "ghp-test",
};

const originalEnv = { ...process.env };

try {
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
  assert.equal(
    buildPreflightReport(baseSettings).checks.find((check) => check.name === "modal_credentials")?.ok,
    false,
  );

  process.env.MODAL_TOKEN_ID = "id";
  process.env.MODAL_TOKEN_SECRET = "secret";
  const ready = buildPreflightReport(baseSettings);
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.sandboxEnvResolvedNames, ["OPENAI_API_KEY"]);

  const missingSandboxEnv = buildPreflightReport({
    ...baseSettings,
    sandboxEnv: {},
    sandboxEnvNames: [],
  });
  assert.equal(missingSandboxEnv.ok, false);
  assert.equal(missingSandboxEnv.checks.find((check) => check.name === "sandbox_env_allowlist")?.ok, false);
} finally {
  process.env = originalEnv;
}

console.log("preflight tests passed");
