import { getAgentRepositoryMetadata, type AgentRepositoryRecord } from "./agentRepository.js";
import { parseGitHubHttpsRepoUrl } from "./gitLinks.js";
import { assertValidBranchName, toBranchSegment } from "./git.js";
import type { Settings } from "./config.js";
import type { BaseRepo, CreateRepoOptions } from "@pierre/storage";

export type CodeStorageCreateInput = {
  agent: AgentRepositoryRecord;
  dryRun?: boolean;
  repoId?: string;
};

export type CodeStorageCreateResult = {
  codeStorageRepoId: string;
  defaultBranch: string;
  live: boolean;
  organizationName: string;
  remoteUrl: string | null;
  remoteUrlRedacted: string | null;
  source: CodeStorageSource | null;
};

export type CodeStorageSource = {
  defaultBranch: string;
  name: string;
  owner: string;
  provider: "github";
};

export class CodeStorageService {
  constructor(private readonly settings: Settings) {}

  async createRepository(input: CodeStorageCreateInput): Promise<CodeStorageCreateResult> {
    const metadata = getAgentRepositoryMetadata(input.agent);
    const organizationName = requireOrganizationName(this.settings.codeStorageName);
    const codeStorageRepoId = normalizeCodeStorageRepoId(input.repoId ?? input.agent.id);
    const defaultBranch = assertValidBranchName(metadata.defaultBranch);
    const source = sourceFromAgent(input.agent);
    const live = input.dryRun !== true;

    if (!live) {
      const remoteUrl = dryRunRemoteUrl(organizationName, codeStorageRepoId);
      return {
        codeStorageRepoId,
        defaultBranch,
        live: false,
        organizationName,
        remoteUrl,
        remoteUrlRedacted: redactRemoteUrl(remoteUrl),
        source,
      };
    }

    const privateKey = this.settings.codeStoragePrivateKey;
    if (!privateKey) throw new Error("CODE_STORAGE_PRIVATE_KEY is required for live Code.Storage operations");

    const { GitStorage } = await import("@pierre/storage");
    const store = new GitStorage({
      name: organizationName,
      key: privateKey,
    });
    const createOptions: CreateRepoOptions = {
      id: codeStorageRepoId,
      ...(source ? { baseRepo: sourceToBaseRepo(source) } : { defaultBranch }),
    };
    const repo = await store.createRepo(createOptions);
    const remoteUrl = await getRemoteUrl(repo);

    return {
      codeStorageRepoId: repo.id ?? codeStorageRepoId,
      defaultBranch,
      live: true,
      organizationName,
      remoteUrl,
      remoteUrlRedacted: redactRemoteUrl(remoteUrl),
      source,
    };
  }
}

export const sourceFromAgent = (agent: AgentRepositoryRecord): CodeStorageSource | null => {
  const github = parseGitHubHttpsRepoUrl(agent.repo_url);
  if (!github) return null;
  return {
    defaultBranch: assertValidBranchName(agent.default_branch),
    name: github.repo,
    owner: github.owner,
    provider: "github",
  };
};

export const normalizeCodeStorageRepoId = (value: string): string =>
  toBranchSegment(value, "repo", { maxLength: 80 }).replaceAll("_", "-");

export const redactRemoteUrl = (remoteUrl: string | null): string | null => {
  if (!remoteUrl) return null;
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "t" : "";
      parsed.password = parsed.password ? "REDACTED" : "";
    }
    return parsed.toString();
  } catch {
    return remoteUrl.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:REDACTED@");
  }
};

const requireOrganizationName = (value: string | undefined): string => {
  if (!value?.trim()) {
    throw new Error("CODE_STORAGE_NAME is required for Code.Storage operations");
  }
  return value.trim();
};

const sourceToBaseRepo = (source: CodeStorageSource): BaseRepo => ({
  provider: source.provider,
  owner: source.owner,
  name: source.name,
  defaultBranch: source.defaultBranch,
  auth: { authType: "public" },
});

const dryRunRemoteUrl = (organizationName: string, repoId: string): string =>
  `https://t:DRY_RUN_TOKEN@${organizationName}.code.storage/${repoId}.git`;

const getRemoteUrl = async (repo: any): Promise<string> => {
  if (typeof repo.getRemoteURL === "function") return repo.getRemoteURL();
  if (typeof repo.getRemoteUrl === "function") return repo.getRemoteUrl();
  throw new Error("Code.Storage SDK repo object does not expose getRemoteURL()");
};
