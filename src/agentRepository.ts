import { assertValidGitRef, buildBranchName, timestampBranchSegment, toBranchSegment } from "./git.js";
import { gitHubRepoUrl, gitHubTreeUrl } from "./gitLinks.js";
import type { AgentRow } from "./types.js";

export type AgentRepositoryRecord = Pick<AgentRow, "id" | "name" | "repo_url" | "current_ref">;

export const getAgentRepositoryMetadata = (agent: AgentRepositoryRecord) => {
  const currentRef = assertValidGitRef(agent.current_ref);

  return {
    agentId: agent.id,
    currentRef,
    currentTreeUrl: gitHubTreeUrl(agent.repo_url, currentRef),
    name: agent.name,
    repoUrl: agent.repo_url,
    repoWebUrl: gitHubRepoUrl(agent.repo_url),
  };
};

export const planRunBranch = (input: {
  agent: AgentRepositoryRecord;
  now?: Date;
  objective?: string;
  prefix?: string;
  runId: string;
}) => {
  assertValidGitRef(input.agent.current_ref);
  const runIdSegment = toBranchSegment(input.runId, "run", { maxLength: 40 });
  const objectiveSegment = toBranchSegment(input.objective ?? input.agent.name, "task", { maxLength: 48 });
  const agentSegment = toBranchSegment(input.agent.id, "agent", { maxLength: 40 });
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
  };
};
