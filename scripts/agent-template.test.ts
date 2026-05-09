import assert from "node:assert/strict";

import { buildAgentTemplate } from "../src/agentTemplate.js";
import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";

const template = buildAgentTemplate({
  name: "Research Agent",
  description: "Researches one bounded task per run.",
});

assert.equal(template.id, "research-agent");
assert.equal(template.name, "Research Agent");
assert.deepEqual(
  template.files.map((file) => file.path),
  [
    "AGENTS.md",
    ".pi/settings.json",
    ".pi/prompts/heartbeat.md",
    ".pi/prompts/self-review.md",
    ".pi/skills/research/SKILL.md",
    ".pi/skills/self-edit/SKILL.md",
    ".pi/extensions/README.md",
    "state/memory.md",
    "state/decisions.jsonl",
    "tasks/inbox/.gitkeep",
    "findings/.gitkeep",
    "artifacts/.gitkeep",
    ".gitignore",
    "README.md",
  ],
);
assert.match(template.files.find((file) => file.path === "AGENTS.md")?.content ?? "", /Self-Improvement Rules/);
assert.match(template.files.find((file) => file.path === ".gitignore")?.content ?? "", /\.pi\/sessions\//);

assert.throws(
  () => buildAgentTemplate({ name: "Bad", id: "../bad" }),
  /id must start/,
);

const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: ":memory:",
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-agent-template-test",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-agent-template-test",
};

const { app } = await buildServer(settings);

try {
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-template",
    payload: {
      name: "Self Editor",
      id: "self-editor",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"id":"self-editor"/);
  assert.match(response.body, /"path":"\.pi\/prompts\/heartbeat\.md"/);

  const badResponse = await app.inject({
    method: "POST",
    url: "/api/agent-template",
    payload: { name: "" },
  });
  assert.equal(badResponse.statusCode, 400);

  const initResponse = await app.inject({
    method: "POST",
    url: "/api/agents/from-template",
    payload: {
      name: "Fresh Agent",
      id: "fresh-agent",
      repoId: "fresh-agent-repo",
      dryRun: true,
    },
  });
  assert.equal(initResponse.statusCode, 200);
  assert.match(initResponse.body, /"repo_url":"https:\/\/github\.com\/threadbeat-agent-template-test\/fresh-agent-repo\.git"/);
  assert.match(initResponse.body, /"hostedGitRepo":/);
  assert.match(initResponse.body, /"path":"AGENTS.md"/);
  assert.match(initResponse.body, /"initialized":null/);
} finally {
  await app.close();
}
