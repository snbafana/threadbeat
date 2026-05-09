import assert from "node:assert/strict";

const originalEnv = { ...process.env };

try {
  process.env.MODAL_TOKEN_ID = "";
  process.env.MODAL_TOKEN_SECRET = "";
  process.env.DEEPSEEK_API_KEY = "sk-test";

  const { loadSettings } = await import(`../src/config.js?config-test=${Date.now()}`);
  const settings = loadSettings();

  assert.equal(settings.modalMode, "dry-run");
  assert.deepEqual(settings.sandboxEnvNames, ["DEEPSEEK_API_KEY"]);
  assert.deepEqual(settings.sandboxEnv, {
    DEEPSEEK_API_KEY: "sk-test",
  });
  assert.equal(settings.agentPiProvider, "deepseek");
  assert.equal(settings.agentPiModel, "deepseek-v4-flash");
  assert.equal(settings.agentPiApiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(settings.modalInstallSandboxPi, true);
  assert.ok(settings.modalImageCommands?.some((command: string) => command.includes("@mariozechner/pi-coding-agent")));

  process.env.MODAL_TOKEN_ID = "token-id";
  process.env.MODAL_TOKEN_SECRET = "token-secret";
  assert.equal(loadSettings().modalMode, "live");
} finally {
  process.env = originalEnv;
}

console.log("config tests passed");
