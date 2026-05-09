import assert from "node:assert/strict";

const originalEnv = { ...process.env };

try {
  process.env.THREADBEAT_SANDBOX_ENV_ALLOWLIST = "OPENAI_API_KEY,ANTHROPIC_API_KEY\nPI_OFFLINE";
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PI_OFFLINE = "1";

  const { loadSettings } = await import(`../src/config.js?config-test=${Date.now()}`);
  const settings = loadSettings();

  assert.deepEqual(settings.sandboxEnvNames, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PI_OFFLINE"]);
  assert.deepEqual(settings.sandboxEnv, {
    OPENAI_API_KEY: "sk-test",
    PI_OFFLINE: "1",
  });
} finally {
  process.env = originalEnv;
}

console.log("config tests passed");
