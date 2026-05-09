import { deriveGitHubLinks, type GitHubLinkSet } from "./gitLinks.js";
import type { AgentRepositoryRecord } from "./agentRepository.js";
import type { AgentRunRow } from "./types.js";

export type PersistedRunPlan = {
  branchName: string;
  compareBaseRef: string;
  compareHeadRef: string;
  links: GitHubLinkSet;
  runId: string;
  sourceRef: string;
};

export const runPlanFromRow = (agent: AgentRepositoryRecord, run: AgentRunRow): PersistedRunPlan => ({
  branchName: run.run_branch,
  compareBaseRef: run.input_ref,
  compareHeadRef: run.run_branch,
  links: deriveGitHubLinks(agent.repo_url, {
    compareBaseRef: run.input_ref,
    compareHeadRef: run.run_branch,
    treeRef: run.run_branch,
  }),
  runId: run.id,
  sourceRef: run.input_ref,
});
