import assert from "node:assert/strict";

const originalEnv = { ...process.env };

try {
  process.env.THREADBEAT_SANDBOX_ENV_ALLOWLIST = "DEEPSEEK_API_KEY,OPENAI_API_KEY\nPI_OFFLINE";
  process.env.DEEPSEEK_API_KEY = "sk-test";
  delete process.env.OPENAI_API_KEY;
  process.env.PI_OFFLINE = "1";

  const { loadSettings } = await import(`../src/config.js?config-test=${Date.now()}`);
  const settings = loadSettings();

  assert.deepEqual(settings.sandboxEnvNames, ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "PI_OFFLINE"]);
  assert.deepEqual(settings.sandboxEnv, {
    DEEPSEEK_API_KEY: "sk-test",
    PI_OFFLINE: "1",
  });
} finally {
  process.env = originalEnv;
}

console.log("config tests passed");
