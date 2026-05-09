import { assertValidGitRef } from "./git.js";

type GitHubRepoParts = {
  owner: string;
  repo: string;
  webUrl: string;
};

type GitHubLinkSet = {
  commitUrl: string | null;
  compareUrl: string | null;
  repoUrl: string | null;
  treeUrl: string | null;
};

export const parseGitHubHttpsRepoUrl = (repoUrl: string): GitHubRepoParts | null => {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() !== "github.com") return null;

  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;

  const [owner, rawRepo] = parts;
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!isGitHubOwner(owner) || !isGitHubRepo(repo)) return null;

  return {
    owner,
    repo,
    webUrl: `https://github.com/${owner}/${repo}`,
  };
};

export const gitHubRepoUrl = (repoUrl: string): string | null =>
  parseGitHubHttpsRepoUrl(repoUrl)?.webUrl ?? null;

export const gitHubTreeUrl = (repoUrl: string, ref: string): string | null => {
  const repo = parseGitHubHttpsRepoUrl(repoUrl);
  if (!repo) return null;
  const safeRef = assertValidGitRef(ref);
  return `${repo.webUrl}/tree/${encodeRefPath(safeRef)}`;
};

export const gitHubCommitUrl = (repoUrl: string, commitRef: string | null | undefined): string | null => {
  if (!commitRef) return null;
  const repo = parseGitHubHttpsRepoUrl(repoUrl);
  if (!repo) return null;
  const safeRef = assertValidGitRef(commitRef);
  return `${repo.webUrl}/commit/${encodeRefPath(safeRef)}`;
};

export const gitHubCompareUrl = (
  repoUrl: string,
  baseRef: string | null | undefined,
  headRef: string | null | undefined,
): string | null => {
  if (!baseRef || !headRef) return null;
  const repo = parseGitHubHttpsRepoUrl(repoUrl);
  if (!repo) return null;
  const safeBase = assertValidGitRef(baseRef);
  const safeHead = assertValidGitRef(headRef);
  return `${repo.webUrl}/compare/${encodeRefPath(safeBase)}...${encodeRefPath(safeHead)}`;
};

export const deriveGitHubLinks = (
  repoUrl: string,
  refs: {
    commitRef?: string | null;
    compareBaseRef?: string | null;
    compareHeadRef?: string | null;
    treeRef?: string | null;
  },
): GitHubLinkSet => ({
  commitUrl: gitHubCommitUrl(repoUrl, refs.commitRef),
  compareUrl: gitHubCompareUrl(repoUrl, refs.compareBaseRef, refs.compareHeadRef),
  repoUrl: gitHubRepoUrl(repoUrl),
  treeUrl: refs.treeRef ? gitHubTreeUrl(repoUrl, refs.treeRef) : null,
});

const encodeRefPath = (ref: string): string =>
  ref.split("/").map((part) => encodeURIComponent(part)).join("/");

const isGitHubOwner = (value: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);

const isGitHubRepo = (value: string): boolean => /^[A-Za-z0-9._-]+$/.test(value);
