import fs from "node:fs/promises";
import path from "node:path";

export type FakeExecutorOptions = {
  now?: Date;
  executorName?: string;
};

export type FakeExecutorResult = {
  status: "succeeded";
  executor: string;
  inputPath: string;
  resultPath: string;
  summaryPath: string;
  objective: string;
  metadata: Record<string, unknown> | null;
  completedAt: string;
};

export async function runFakeAgentExecutor(
  repoPath: string,
  options: FakeExecutorOptions = {},
): Promise<FakeExecutorResult> {
  const root = path.resolve(repoPath);
  const inputPath = path.join(root, "work", "inputs", "task.md");
  const resultPath = path.join(root, "work", "outputs", "result.md");
  const summaryPath = path.join(root, "work", "outputs", "run-summary.json");
  const executor = options.executorName ?? "threadbeat-fake-executor";
  const completedAt = (options.now ?? new Date()).toISOString();
  const taskMarkdown = await readTaskInput(inputPath);
  const objective = extractSection(taskMarkdown, "Objective") || taskMarkdown.trim();
  const metadata = extractMetadata(taskMarkdown);

  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.writeFile(
    resultPath,
    formatFakeResult({ executor, completedAt, objective, metadata, taskMarkdown }),
    "utf8",
  );

  const result: FakeExecutorResult = {
    status: "succeeded",
    executor,
    inputPath,
    resultPath,
    summaryPath,
    objective,
    metadata,
    completedAt,
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  return result;
}

function formatFakeResult(input: {
  executor: string;
  completedAt: string;
  objective: string;
  metadata: Record<string, unknown> | null;
  taskMarkdown: string;
}): string {
  const lines = [
    "# Threadbeat fake executor result",
    "",
    `status: succeeded`,
    `executor: ${input.executor}`,
    `completed_at: ${input.completedAt}`,
    "",
    "## Objective",
    "",
    input.objective,
  ];

  if (input.metadata !== null) {
    lines.push("", "## Metadata", "", "```json", JSON.stringify(input.metadata, null, 2), "```");
  }

  lines.push(
    "",
    "## Execution",
    "",
    "This fake executor read `work/inputs/task.md` and produced local E2E output without Pi.",
    "",
    "## Input digest",
    "",
    `characters: ${input.taskMarkdown.length}`,
    "",
  );

  return lines.join("\n");
}

async function readTaskInput(inputPath: string): Promise<string> {
  try {
    return await fs.readFile(inputPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`Missing run input at ${inputPath}`);
    }
    throw error;
  }
}

function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingLine = `## ${heading}`;
  const start = lines.findIndex((line) => line.trim() === headingLine);
  if (start === -1) return "";

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    body.push(line);
  }

  return body.join("\n").trim();
}

function extractMetadata(markdown: string): Record<string, unknown> | null {
  const metadataSection = extractSection(markdown, "Metadata");
  if (!metadataSection) return null;

  const fencedJson = metadataSection.match(/```json\s*([\s\S]*?)```/);
  const json = fencedJson?.[1] ?? metadataSection;
  const parsed = JSON.parse(json) as unknown;

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run input metadata must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}
