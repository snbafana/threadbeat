import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_TEMPLATE_NAME = "agent-basic";

export const AGENT_TEMPLATE_FILES = [
  "AGENTS.md",
  ".pi/settings.json",
  ".pi/prompts/heartbeat.md",
  "agent/state/memory.md",
  "work/inputs/.gitkeep",
  "work/outputs/.gitkeep",
  "work/scratch/.gitignore",
] as const;

export type AgentTemplateFile = (typeof AGENT_TEMPLATE_FILES)[number];

export type CopyAgentTemplateOptions = {
  templatePath?: string;
  overwrite?: boolean;
};

export type CopyAgentTemplateResult = {
  repoPath: string;
  templatePath: string;
  created: AgentTemplateFile[];
  overwritten: AgentTemplateFile[];
  skipped: AgentTemplateFile[];
};

export type RunInput = {
  objective: string;
  metadata?: Record<string, unknown>;
};

export type WriteRunInputResult = {
  inputPath: string;
  relativePath: "work/inputs/task.md";
};

export async function copyAgentTemplate(
  repoPath: string,
  options: CopyAgentTemplateOptions = {},
): Promise<CopyAgentTemplateResult> {
  const targetRoot = path.resolve(repoPath);
  const templatePath = path.resolve(options.templatePath ?? (await defaultAgentTemplatePath()));
  const created: AgentTemplateFile[] = [];
  const overwritten: AgentTemplateFile[] = [];
  const skipped: AgentTemplateFile[] = [];

  await fs.mkdir(targetRoot, { recursive: true });

  for (const relativePath of AGENT_TEMPLATE_FILES) {
    const sourcePath = path.join(templatePath, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    const exists = await fileExists(targetPath);

    if (exists && !options.overwrite) {
      skipped.push(relativePath);
      continue;
    }

    const contents = await fs.readFile(sourcePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, contents);

    if (exists) overwritten.push(relativePath);
    else created.push(relativePath);
  }

  return { repoPath: targetRoot, templatePath, created, overwritten, skipped };
}

export async function writeRunInput(
  repoPath: string,
  input: RunInput,
): Promise<WriteRunInputResult> {
  const objective = input.objective.trim();
  if (!objective) throw new Error("Run input objective must not be empty");

  const inputPath = path.join(path.resolve(repoPath), "work", "inputs", "task.md");
  await fs.mkdir(path.dirname(inputPath), { recursive: true });
  await fs.writeFile(inputPath, formatRunInput(objective, input.metadata), "utf8");

  return { inputPath, relativePath: "work/inputs/task.md" };
}

export function formatRunInput(
  objective: string,
  metadata?: Record<string, unknown>,
): string {
  const parts = ["# Threadbeat task", "", "## Objective", "", objective.trim()];

  if (metadata !== undefined) {
    parts.push("", "## Metadata", "", "```json", JSON.stringify(metadata, null, 2), "```");
  }

  parts.push("");
  return parts.join("\n");
}

async function defaultAgentTemplatePath(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "templates", AGENT_TEMPLATE_NAME),
    path.resolve(process.cwd(), "templates", AGENT_TEMPLATE_NAME),
    path.resolve(moduleDir, "..", "..", "templates", AGENT_TEMPLATE_NAME),
  ];

  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, "AGENTS.md"))) return candidate;
  }

  throw new Error(`Unable to locate ${AGENT_TEMPLATE_NAME} template`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
