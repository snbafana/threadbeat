import { CodeStorageService, type CodeStorageCreateResult } from "./codeStorage.js";
import type { AgentRepositoryRecord } from "./agentRepository.js";
import type { Settings } from "./config.js";

export type HostedGitProviderName = "code-storage";

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

export const createHostedGitProvider = (settings: Settings): HostedGitProvider => {
  const provider = settings.hostedGitProvider ?? "code-storage";
  if (provider === "code-storage") return new CodeStorageHostedGitProvider(settings);
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
