import assert from "node:assert/strict";

export const piFixture = {
  repoUrl: process.env.THREADBEAT_PI_FIXTURE_REPO_URL ?? "https://github.com/snbafana/threadbeat.git",
  branch: process.env.THREADBEAT_PI_FIXTURE_BRANCH,
};

export const samplePiRepoPath = "workspace/repo/.threadbeat-smoke/pi-sample-repo";

export function requireDeepseekKey() {
  assert.ok(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY is required");
  return process.env.DEEPSEEK_API_KEY;
}

export function ensureNode22Command() {
  return "apt-get update >/dev/null && apt-get install -y curl ca-certificates 2>&1 && npm install -g n 2>&1 && n 22 2>&1 && hash -r && node --version && npm --version";
}

export function piInjectionCheckCommand() {
  return String.raw`cat > .threadbeat-pi-injection-check.mjs <<'EOF'
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import path from "node:path";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("missing DEEPSEEK_API_KEY");

const authStorage = AuthStorage.create();
authStorage.setRuntimeApiKey("deepseek", process.env.DEEPSEEK_API_KEY);
const registry = new ModelRegistry(authStorage, path.join(process.cwd(), "pi-models.json"));
const model = registry.find("deepseek", "deepseek-v4-flash");
if (!model) throw new Error("deepseek-v4-flash not resolved");

const response = await fetch("https://api.deepseek.com/v1/models", {
  headers: { authorization: "Bearer " + process.env.DEEPSEEK_API_KEY },
});
if (!response.ok) throw new Error("deepseek auth failed: " + response.status);

console.log("pi-auth-ok");
EOF
node .threadbeat-pi-injection-check.mjs 2>&1`;
}

export function materializeSamplePiRepoCommand() {
  return String.raw`set -e
rm -rf .threadbeat-smoke/pi-sample-repo
mkdir -p .threadbeat-smoke/pi-sample-repo
cd .threadbeat-smoke/pi-sample-repo
git init
git config user.email threadbeat-smoke@example.com
git config user.name threadbeat-smoke
cat > package.json <<'EOF'
{
  "name": "threadbeat-pi-sample-repo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "^0.60.0"
  }
}
EOF
cat > pi-models.json <<'EOF'
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "api": "openai-completions",
      "apiKey": "DEEPSEEK_API_KEY",
      "authHeader": true,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
EOF
cat > README.md <<'EOF'
# Threadbeat Pi sample repo

This fixture is materialized by smoke tests inside a Daytona sandbox.
EOF
git add .
git commit -m "create pi sample repo"
cd ../..
echo sample-pi-repo-created`;
}

export function installSamplePiRepoCommand() {
  return [
    ensureNode22Command(),
    "cd .threadbeat-smoke/pi-sample-repo",
    "npm install --no-audit --no-fund",
    "test -d node_modules/@mariozechner/pi-coding-agent",
  ].join(" && ");
}
