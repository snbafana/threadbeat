export type AgentTemplateInput = {
  name: string;
  id?: string;
  description?: string;
};

export type AgentTemplateFile = {
  path: string;
  content: string;
};

export type AgentTemplate = {
  id: string;
  name: string;
  files: AgentTemplateFile[];
};

export const buildAgentTemplate = (input: AgentTemplateInput): AgentTemplate => {
  const name = cleanRequired(input.name, "name");
  const id = input.id ? cleanId(input.id) : slugify(name);
  const description = input.description?.trim() || "A git-backed Threadbeat agent that runs through Pi inside a sandbox.";

  return {
    id,
    name,
    files: [
      file("AGENTS.md", agentsMd({ id, name, description })),
      file(".pi/settings.json", piSettingsJson()),
      file(".pi/prompts/heartbeat.md", heartbeatPrompt()),
      file(".pi/prompts/self-review.md", selfReviewPrompt()),
      file(".pi/skills/research/SKILL.md", researchSkill()),
      file(".pi/skills/self-edit/SKILL.md", selfEditSkill()),
      file(".pi/extensions/README.md", extensionsReadme()),
      file("state/memory.md", memoryMd({ id, name, description })),
      file("state/decisions.jsonl", ""),
      file("tasks/inbox/.gitkeep", ""),
      file("findings/.gitkeep", ""),
      file("artifacts/.gitkeep", ""),
      file(".gitignore", gitignore()),
      file("README.md", readmeMd({ id, name, description })),
    ],
  };
};

const file = (path: string, content: string): AgentTemplateFile => ({ path, content });

const agentsMd = ({ name, description }: { id: string; name: string; description: string }): string => `# ${name}

${description}

## Operating Contract

- Treat this repository as the durable body of the agent.
- Read \`state/memory.md\` before starting work.
- Read the newest task under \`tasks/inbox/\` when a task file exists.
- Do one bounded step per run.
- Write durable findings under \`findings/\` or \`artifacts/\`.
- Update \`state/memory.md\` only with durable state that should survive future runs.
- Append decision notes to \`state/decisions.jsonl\` as JSON lines.
- Keep scratch work in \`work/\`, \`tmp/\`, or \`.cache/\`; those paths are not durable.

## Self-Improvement Rules

- Propose changes to \`AGENTS.md\`, \`.pi/prompts/\`, \`.pi/skills/\`, and \`.pi/extensions/\` on a run branch.
- Do not rewrite history, delete run logs, or weaken permissions.
- Leave promotion decisions to Threadbeat after review or evals.
`;

const piSettingsJson = (): string => `${JSON.stringify({
  enableSkillCommands: true,
  sessionDir: ".pi/sessions",
}, null, 2)}
`;

const heartbeatPrompt = (): string => `# Heartbeat

Read \`state/memory.md\` and the newest task under \`tasks/inbox/\` if one exists.

Do one bounded step. Prefer a concrete file update or a concise finding over broad planning.

Before stopping:

- Update \`state/memory.md\` if durable state changed.
- Append one JSON line to \`state/decisions.jsonl\` when you made a meaningful decision.
- Summarize what changed and the next smallest useful step.
`;

const selfReviewPrompt = (): string => `# Self Review

Review recent repository changes, \`state/memory.md\`, and \`state/decisions.jsonl\`.

Look for repeated failures, vague outputs, missing checks, or instructions that should become a skill.

If a self-edit is useful, make the smallest change to \`AGENTS.md\`, \`.pi/prompts/\`, or \`.pi/skills/\` and explain why in \`state/decisions.jsonl\`.
`;

const researchSkill = (): string => `# Research

Use this skill when the task is exploratory and should leave durable notes.

## Process

1. Restate the specific question in one sentence.
2. Gather the smallest amount of evidence needed for the next step.
3. Write notes under \`findings/\` with sources or local file references.
4. Update \`state/memory.md\` only with reusable conclusions.
`;

const selfEditSkill = (): string => `# Self Edit

Use this skill when improving this agent's own instructions, prompts, or skills.

## Guardrails

- Edit on a run branch, not directly on the promoted branch.
- Prefer one small instruction improvement at a time.
- Add or update a prompt/skill when a repeated workflow appears.
- Record the reason for the edit in \`state/decisions.jsonl\`.
`;

const extensionsReadme = (): string => `# Extensions

Place Pi TypeScript extensions here when this agent needs repo-local runtime hooks.

Threadbeat should load this repository as the sandbox Pi working directory. Server-side Pi integrations stay separate from sandbox-agent Pi integrations.
`;

const memoryMd = ({ id, name, description }: { id: string; name: string; description: string }): string => `# Memory

Agent: ${name}
ID: ${id}

${description}

## Durable State

- Initialized from the default Threadbeat Pi-native template.
`;

const gitignore = (): string => `work/
tmp/
.cache/
.pi/sessions/
node_modules/
`;

const readmeMd = ({ id, name, description }: { id: string; name: string; description: string }): string => `# ${name}

${description}

This is a Pi-native Threadbeat agent repository.

## Layout

- \`AGENTS.md\`: durable identity and operating policy.
- \`.pi/prompts/\`: reusable run prompts.
- \`.pi/skills/\`: progressive-disclosure skills.
- \`.pi/extensions/\`: optional repo-local Pi extensions.
- \`state/\`: durable memory and decision logs.
- \`tasks/inbox/\`: bounded task files.
- \`findings/\` and \`artifacts/\`: durable outputs.
- \`work/\`: ignored scratch space.

Agent ID: \`${id}\`
`;

const cleanRequired = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be a non-empty string`);
  return trimmed;
};

const cleanId = (value: string): string => {
  const trimmed = cleanRequired(value, "id");
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(trimmed)) {
    throw new Error("id must start with a letter or number and contain only letters, numbers, '.', '_', or '-'");
  }
  return trimmed;
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
  || "agent";
