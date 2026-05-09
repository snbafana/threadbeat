import { assertValidBranchName, assertValidGitRef, buildBranchName, timestampBranchSegment, toBranchSegment } from "./git.js";
import { deriveGitHubLinks, gitHubRepoUrl, gitHubTreeUrl, type GitHubLinkSet } from "./gitLinks.js";
import type { AgentRow } from "./types.js";

export type AgentRepositoryRecord = Pick<AgentRow, "id" | "name" | "repo_url" | "default_branch" | "current_ref">;

export type AgentRepositoryMetadata = {
  agentId: string;
  currentRef: string;
  currentTreeUrl: string | null;
  defaultBranch: string;
  defaultBranchTreeUrl: string | null;
  name: string;
  repoUrl: string;
  repoWebUrl: string | null;
};

export type PlanRunBranchInput = {
  agent: AgentRepositoryRecord;
  now?: Date;
  objective?: string;
  prefix?: string;
  runId: string;
};

export type RunBranchPlan = {
  branchName: string;
  compareBaseRef: string;
  compareHeadRef: string;
  links: GitHubLinkSet;
  runId: string;
  sourceRef: string;
};

export const getAgentRepositoryMetadata = (agent: AgentRepositoryRecord): AgentRepositoryMetadata => {
  const defaultBranch = assertValidBranchName(agent.default_branch);
  const currentRef = assertValidGitRef(agent.current_ref);

  return {
    agentId: agent.id,
    currentRef,
    currentTreeUrl: gitHubTreeUrl(agent.repo_url, currentRef),
    defaultBranch,
    defaultBranchTreeUrl: gitHubTreeUrl(agent.repo_url, defaultBranch),
    name: agent.name,
    repoUrl: agent.repo_url,
    repoWebUrl: gitHubRepoUrl(agent.repo_url),
  };
};

export const planRunBranch = (input: PlanRunBranchInput): RunBranchPlan => {
  const metadata = getAgentRepositoryMetadata(input.agent);
  const runIdSegment = toBranchSegment(input.runId, "run", { maxLength: 40 });
  const objectiveSegment = toBranchSegment(input.objective ?? metadata.name, "task", { maxLength: 48 });
  const agentSegment = toBranchSegment(metadata.agentId, "agent", { maxLength: 40 });
  const prefixSegment = toBranchSegment(input.prefix ?? "threadbeat/runs", "threadbeat_runs", {
    maxLength: 80,
  });
  const branchName = buildBranchName([
    ...prefixSegment.split("_"),
    timestampBranchSegment(input.now),
    agentSegment,
    `${runIdSegment}-${objectiveSegment}`,
  ]);

  return {
    branchName,
    compareBaseRef: metadata.currentRef,
    compareHeadRef: branchName,
    links: deriveGitHubLinks(metadata.repoUrl, {
      compareBaseRef: metadata.currentRef,
      compareHeadRef: branchName,
      treeRef: branchName,
    }),
    runId: input.runId,
    sourceRef: metadata.currentRef,
  };
};
