import assert from "node:assert/strict";

import { buildPreflightReport } from "../src/preflight.js";
import { scriptSettings } from "./settings-utils.js";

const baseSettings = scriptSettings({
  modalMode: "live",
  modalAppName: "threadbeat-test",
  overrides: {
    modalInstallSandboxPi: true,
    sandboxEnv: { DEEPSEEK_API_KEY: "sk-test" },
    sandboxEnvNames: ["DEEPSEEK_API_KEY"],
    sandboxExecTimeoutMs: 120_000,
    agentBootTimeoutMs: 600_000,
    agentPiProvider: "deepseek",
    agentPiModel: "deepseek-v4-flash",
    agentPiApiKeyEnv: "DEEPSEEK_API_KEY",
    githubOwner: "snbafana",
    githubToken: "ghp-test",
  },
});

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

  const missingSandboxEnv = buildPreflightReport({
    ...baseSettings,
    sandboxEnv: {},
    sandboxEnvNames: [],
  });
  assert.equal(missingSandboxEnv.ok, false);
  assert.equal(missingSandboxEnv.checks.find((check) => check.name === "sandbox_pi_auth")?.ok, false);
} finally {
  process.env = originalEnv;
}

console.log("preflight tests passed");
