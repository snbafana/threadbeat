import { deriveGitHubLinks } from "./gitLinks.js";
import type { AgentRepositoryRecord } from "./agentRepository.js";
import type { AgentRunRow } from "./types.js";

export const runPlanFromRow = (agent: AgentRepositoryRecord, run: AgentRunRow) => ({
  branchName: run.run_branch,
  links: deriveGitHubLinks(agent.repo_url, {
    compareBaseRef: run.input_ref,
    compareHeadRef: run.run_branch,
    treeRef: run.run_branch,
  }),
});
