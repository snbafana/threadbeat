import { CodeStorageService, type CodeStorageCreateResult } from "./codeStorage.js";
import type { AgentRepositoryRecord } from "./agentRepository.js";
import { assertValidBranchName, toBranchSegment } from "./git.js";
import { RateLimitGuard, githubCreateRepoRateLimitRules } from "./rateLimit.js";
import type { Settings } from "./config.js";

type FetchLike = typeof fetch;

export type HostedGitProviderName = "code-storage" | "github";

export type HostedGitCreateInput = {
  agent: AgentRepositoryRecord;
  dryRun?: boolean;
  repoId?: string;
};

export type HostedGitCloneInput = {
  namespace: string;
  repoId: string;
};

export type HostedGitCloneUrl = {
  remoteUrl: string;
  remoteUrlRedacted: string;
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
  getCloneUrl(input: HostedGitCloneInput): Promise<HostedGitCloneUrl>;
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

  async getCloneUrl(input: HostedGitCloneInput): Promise<HostedGitCloneUrl> {
    const remoteUrl = await this.codeStorage.getRepositoryRemoteUrl(input.repoId);
    return {
      remoteUrl,
      remoteUrlRedacted: redactHostedGitRemoteUrl(remoteUrl) ?? remoteUrl,
    };
  }
}

export class GitHubHostedGitProvider implements HostedGitProvider {
  readonly name = "github";

  constructor(
    private readonly settings: Settings,
    private readonly rateLimitGuard = new RateLimitGuard(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async createRepository(input: HostedGitCreateInput): Promise<HostedGitRepository> {
    const owner = requireGitHubOwner(this.settings.githubOwner);
    const repoId = normalizeGitHubRepoName(input.repoId ?? input.agent.id);
    const defaultBranch = assertValidBranchName(input.agent.default_branch);
    const live = input.dryRun !== true;

    if (live) {
      const token = requireGitHubToken(this.settings.githubToken);
      enforceRateLimit(this.rateLimitGuard.check(
        `github:create-repo:${owner}`,
        githubCreateRepoRateLimitRules,
      ));
      return this.createLiveRepository({ defaultBranch, owner, repoId, token });
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

  async getCloneUrl(input: HostedGitCloneInput): Promise<HostedGitCloneUrl> {
    const owner = requireGitHubOwner(input.namespace);
    const repoId = normalizeGitHubRepoName(input.repoId);
    const token = this.settings.githubToken?.trim() || "DRY_RUN_TOKEN";
    const remoteUrl = githubRemoteUrl({ owner, repoId, token });
    return {
      remoteUrl,
      remoteUrlRedacted: redactHostedGitRemoteUrl(remoteUrl) ?? remoteUrl,
    };
  }

  private async createLiveRepository(input: {
    defaultBranch: string;
    owner: string;
    repoId: string;
    token: string;
  }): Promise<HostedGitRepository> {
    const ownerType = await this.resolveOwnerType(input.owner, input.token);
    const endpoint = ownerType === "user"
      ? "https://api.github.com/user/repos"
      : `https://api.github.com/orgs/${encodeURIComponent(input.owner)}/repos`;
    const response = await this.fetchImpl(endpoint, {
      body: JSON.stringify({
        auto_init: false,
        name: input.repoId,
        private: true,
      }),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
        "user-agent": "threadbeat",
        "x-github-api-version": "2022-11-28",
      },
      method: "POST",
    });
    const body = await parseGitHubJson(response);
    if (response.status !== 201) {
      throw new Error(`GitHub repo create failed (${response.status}): ${githubErrorMessage(body)}`);
    }
    const repo = parseGitHubCreateRepoResponse(body);
    const remoteUrl = githubRemoteUrl({ fullName: repo.fullName, token: input.token });
    return {
      defaultBranch: input.defaultBranch,
      live: true,
      namespace: input.owner,
      provider: "github",
      providerRepoId: repo.name,
      remoteUrl,
      remoteUrlRedacted: redactHostedGitRemoteUrl(remoteUrl),
      source: {
        defaultBranch: input.defaultBranch,
        provider: "github",
        repo: repo.name,
        webUrl: repo.htmlUrl,
      },
    };
  }

  private async resolveOwnerType(owner: string, token: string): Promise<"org" | "user"> {
    const configured = this.settings.githubOwnerType ?? "auto";
    if (configured === "org" || configured === "user") return configured;
    const response = await this.fetchImpl("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "threadbeat",
        "x-github-api-version": "2022-11-28",
      },
      method: "GET",
    });
    const body = await parseGitHubJson(response);
    if (response.status !== 200) {
      throw new Error(`GitHub owner auto-detect failed (${response.status}): ${githubErrorMessage(body)}`);
    }
    const login = githubLogin(body);
    return login.toLowerCase() === owner.toLowerCase() ? "user" : "org";
  }
}

export const createHostedGitProvider = (settings: Settings): HostedGitProvider => {
  const provider = settings.hostedGitProvider ?? "code-storage";
  if (provider === "code-storage") return new CodeStorageHostedGitProvider(settings);
  if (provider === "github") return new GitHubHostedGitProvider(settings);
  throw new Error(`unsupported hosted git provider: ${provider}`);
};

const githubRemoteUrl = (input: { fullName?: string; owner?: string; repoId?: string; token: string }): string => {
  const fullName = input.fullName ?? `${input.owner}/${input.repoId}`;
  return `https://x-access-token:${encodeURIComponent(input.token)}@github.com/${fullName}.git`;
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

const parseGitHubJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
};

const githubErrorMessage = (body: unknown): string => {
  if (!body || typeof body !== "object") return "unknown error";
  const message = (body as Record<string, unknown>).message;
  return typeof message === "string" ? message : "unknown error";
};

const githubLogin = (body: unknown): string => {
  if (!body || typeof body !== "object") throw new Error("GitHub /user returned an invalid response");
  const login = (body as Record<string, unknown>).login;
  if (typeof login !== "string" || !login.trim()) throw new Error("GitHub /user returned an invalid response");
  return login.trim();
};

const parseGitHubCreateRepoResponse = (body: unknown): { fullName: string; htmlUrl: string; name: string } => {
  if (!body || typeof body !== "object") throw new Error("GitHub repo create returned an invalid response");
  const record = body as Record<string, unknown>;
  const fullName = record.full_name;
  const htmlUrl = record.html_url;
  const name = record.name;
  if (typeof fullName !== "string" || typeof htmlUrl !== "string" || typeof name !== "string") {
    throw new Error("GitHub repo create returned an invalid response");
  }
  return { fullName, htmlUrl, name };
};

const enforceRateLimit = (decision: { allowed: boolean; reason?: string; retryAfterMs?: number }): void => {
  if (decision.allowed) return;
  const retrySeconds = Math.ceil((decision.retryAfterMs ?? 0) / 1000);
  throw new Error(`hosted Git rate limit blocked request: ${decision.reason}; retry after ${retrySeconds}s`);
};
