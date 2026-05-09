import { CodeStorageService, type CodeStorageCreateResult } from "./codeStorage.js";
import type { AgentRepositoryRecord } from "./agentRepository.js";
import { assertValidBranchName, toBranchSegment } from "./git.js";
import { RateLimitGuard, githubCreateRepoRateLimitRules } from "./rateLimit.js";
import type { Settings } from "./config.js";

export type HostedGitProviderName = "code-storage" | "github";

export type HostedGitCreateInput = {
  agent: AgentRepositoryRecord;
  dryRun?: boolean;
  repoId?: string;
};

export type HostedGitRepository = {
  defaultBranch: string;
  live: boolean;
  namespace: string;
  provider: HostedGitProviderName;
  providerRepoId: string;
  remoteUrl: string | null;
  remoteUrlRedacted: string | null;
  source: unknown;
};

export interface HostedGitProvider {
  readonly name: HostedGitProviderName;
  createRepository(input: HostedGitCreateInput): Promise<HostedGitRepository>;
}

export class CodeStorageHostedGitProvider implements HostedGitProvider {
  readonly name = "code-storage";
  private readonly codeStorage: CodeStorageService;

  constructor(settings: Settings) {
    this.codeStorage = new CodeStorageService(settings);
  }

  async createRepository(input: HostedGitCreateInput): Promise<HostedGitRepository> {
    return fromCodeStorage(await this.codeStorage.createRepository(input));
  }
}

export class GitHubHostedGitProvider implements HostedGitProvider {
  readonly name = "github";

  constructor(
    private readonly settings: Settings,
    private readonly rateLimitGuard = new RateLimitGuard(),
  ) {}

  async createRepository(input: HostedGitCreateInput): Promise<HostedGitRepository> {
    const owner = requireGitHubOwner(this.settings.githubOwner);
    const repoId = normalizeGitHubRepoName(input.repoId ?? input.agent.id);
    const defaultBranch = assertValidBranchName(input.agent.default_branch);
    const live = input.dryRun !== true;

    if (live) {
      requireGitHubToken(this.settings.githubToken);
      enforceRateLimit(this.rateLimitGuard.check(
        `github:create-repo:${owner}`,
        githubCreateRepoRateLimitRules,
      ));
      throw new Error("live GitHub hosted Git creation is not implemented yet");
    }

    const remoteUrl = `https://x-access-token:DRY_RUN_TOKEN@github.com/${owner}/${repoId}.git`;
    return {
      defaultBranch,
      live: false,
      namespace: owner,
      provider: "github",
      providerRepoId: repoId,
      remoteUrl,
      remoteUrlRedacted: redactHostedGitRemoteUrl(remoteUrl),
      source: {
        defaultBranch,
        provider: "github",
        repo: repoId,
        webUrl: `https://github.com/${owner}/${repoId}`,
      },
    };
  }
}

export const createHostedGitProvider = (settings: Settings): HostedGitProvider => {
  const provider = settings.hostedGitProvider ?? "code-storage";
  if (provider === "code-storage") return new CodeStorageHostedGitProvider(settings);
  if (provider === "github") return new GitHubHostedGitProvider(settings);
  throw new Error(`unsupported hosted git provider: ${provider}`);
};

const fromCodeStorage = (repo: CodeStorageCreateResult): HostedGitRepository => ({
  defaultBranch: repo.defaultBranch,
  live: repo.live,
  namespace: repo.organizationName,
  provider: "code-storage",
  providerRepoId: repo.codeStorageRepoId,
  remoteUrl: repo.remoteUrl,
  remoteUrlRedacted: repo.remoteUrlRedacted,
  source: repo.source,
});

export const normalizeGitHubRepoName = (value: string): string =>
  toBranchSegment(value, "repo", { maxLength: 100 }).replaceAll("_", "-");

export const redactHostedGitRemoteUrl = (remoteUrl: string | null): string | null => {
  if (!remoteUrl) return null;
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username || "x-access-token";
      parsed.password = parsed.password ? "REDACTED" : "";
    }
    return parsed.toString();
  } catch {
    return remoteUrl.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:REDACTED@");
  }
};

const requireGitHubOwner = (owner: string | undefined): string => {
  const trimmed = owner?.trim();
  if (!trimmed) throw new Error("THREADBEAT_GITHUB_OWNER is required for GitHub hosted Git");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(trimmed)) {
    throw new Error("THREADBEAT_GITHUB_OWNER must be a valid GitHub owner name");
  }
  return trimmed;
};

const requireGitHubToken = (token: string | undefined): string => {
  const trimmed = token?.trim();
  if (!trimmed) throw new Error("THREADBEAT_GITHUB_TOKEN or GITHUB_TOKEN is required for live GitHub hosted Git");
  return trimmed;
};

const enforceRateLimit = (decision: { allowed: boolean; reason?: string; retryAfterMs?: number }): void => {
  if (decision.allowed) return;
  const retrySeconds = Math.ceil((decision.retryAfterMs ?? 0) / 1000);
  throw new Error(`hosted Git rate limit blocked request: ${decision.reason}; retry after ${retrySeconds}s`);
};
