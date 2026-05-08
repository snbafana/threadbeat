import fs from "node:fs/promises";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

import type { Settings } from "./config.js";

export type PiAgentExecutorOptions = {
  projectRoot: string;
  repoPath: string;
  provider: string;
  model: string;
  thinking: Settings["piThinking"];
  apiKey?: string;
  timeoutMs: number;
  sessionFactory?: PiAgentSessionFactory;
};

export type PiAgentExecutorResult = {
  status: "succeeded";
  executor: "pi-sdk";
  sessionId: string;
  inputPath: string;
  resultPath: string;
  summaryPath: string;
  assistantText: string;
  completedAt: string;
};

export type PiAgentSessionFactory = (
  options: PiAgentSessionFactoryOptions,
) => Promise<PiAgentSession>;

export type PiAgentSessionFactoryOptions = {
  projectRoot: string;
  repoPath: string;
  provider: string;
  model: string;
  thinking: Settings["piThinking"];
  apiKey?: string;
};

export type PiAgentSession = {
  sessionId: string;
  prompt(text: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  dispose(): void;
  messages?: Array<{ role?: string; errorMessage?: string }>;
};

export async function runPiAgentExecutor(
  options: PiAgentExecutorOptions,
): Promise<PiAgentExecutorResult> {
  const repoPath = path.resolve(options.repoPath);
  const inputPath = path.join(repoPath, "work", "inputs", "task.md");
  const resultPath = path.join(repoPath, "work", "outputs", "result.md");
  const summaryPath = path.join(repoPath, "work", "outputs", "run-summary.json");

  await assertFileExists(inputPath, `Missing run input at ${inputPath}`);
  const session = await (options.sessionFactory ?? createPiAgentSession)(options);
  const completedAt = new Date().toISOString();
  try {
    await withTimeout(
      session.prompt(buildPiAgentPrompt()),
      options.timeoutMs,
      `Pi agent run timed out after ${options.timeoutMs}ms`,
    );
    const lastError = getLastAssistantError(session);
    if (lastError) throw new Error(lastError);
    const assistantText = session.getLastAssistantText();
    if (!assistantText) throw new Error("Pi completed without assistant text");
    await assertFileExists(resultPath, `Pi completed without writing ${resultPath}`);

    const result: PiAgentExecutorResult = {
      status: "succeeded",
      executor: "pi-sdk",
      sessionId: session.sessionId,
      inputPath,
      resultPath,
      summaryPath,
      assistantText,
      completedAt,
    };
    await fs.writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  } finally {
    session.dispose();
  }
}

export function buildPiAgentPrompt(): string {
  return [
    "Run the Threadbeat agent task in this repository.",
    "",
    "Required workflow:",
    "1. Read `work/inputs/task.md` for the current objective and metadata.",
    "2. Use `AGENTS.md`, `.pi/prompts/heartbeat.md`, and `agent/state/memory.md` as agent context.",
    "3. Use `work/scratch/` only for temporary notes or experiments.",
    "4. Write the final durable result to `work/outputs/result.md`.",
    "5. Keep the final assistant response concise and mention the output file written.",
    "",
    "Do not skip writing `work/outputs/result.md`.",
  ].join("\n");
}

async function createPiAgentSession(
  options: PiAgentSessionFactoryOptions,
): Promise<PiAgentSession> {
  const authStorage = AuthStorage.create();
  if (options.apiKey) authStorage.setRuntimeApiKey(options.provider, options.apiKey);
  const modelRegistry = new ModelRegistry(authStorage, path.join(options.projectRoot, "pi-models.json"));
  const model = modelRegistry.find(options.provider, options.model);
  const { session } = await createAgentSession({
    cwd: options.repoPath,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: options.thinking,
    tools: createCodingTools(options.repoPath),
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

async function assertFileExists(filePath: string, message: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(message);
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(message);
    throw error;
  }
}

const getLastAssistantError = (session: PiAgentSession): string | undefined => {
  const assistant = session.messages
    ?.slice()
    .reverse()
    .find((message) => message.role === "assistant");
  return assistant?.errorMessage;
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
