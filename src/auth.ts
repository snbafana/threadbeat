import { execFileSync } from "node:child_process";

export const hasModalCredentials = (source: NodeJS.ProcessEnv): boolean =>
  Boolean(source.MODAL_TOKEN_ID?.trim() && source.MODAL_TOKEN_SECRET?.trim());

export const resolveGitHubToken = (): string | undefined => {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
};

export const collectPresentEnv = (
  names: string[],
  source: NodeJS.ProcessEnv,
): Record<string, string> =>
  Object.fromEntries(names.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
