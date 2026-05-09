import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const cliJson = async <T>(
  baseUrl: string,
  args: string[],
  input: { maxBuffer?: number } = {},
): Promise<T> => {
  const { stdout } = await cliRaw(baseUrl, args, input);
  return JSON.parse(stdout) as T;
};

export const cliJsonLarge = <T>(
  baseUrl: string,
  args: string[],
  input: { maxBuffer?: number } = {},
): Promise<T> =>
  cliJson<T>(baseUrl, args, { maxBuffer: 10 * 1024 * 1024, ...input });

export const cliJsonHuge = <T>(
  baseUrl: string,
  args: string[],
): Promise<T> =>
  cliJsonLarge<T>(baseUrl, args, { maxBuffer: 20 * 1024 * 1024 });

export const stopRunSandboxes = (
  baseUrl: string,
  runId: string,
  input: { maxBuffer?: number } = {},
): Promise<{ stoppedCount: number }> =>
  cliJson(baseUrl, ["sandboxes", "stop-running", "--run", runId], input);

export const cliRaw = async (
  baseUrl: string,
  args: string[],
  input: { maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> =>
  execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    ...(input.maxBuffer === undefined ? {} : { maxBuffer: input.maxBuffer }),
  });
