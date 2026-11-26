import { readOriginUrl } from "./git.js";
import { gitHubForge } from "./github.js";
import { azureDevOpsForge, parseAzureDevOpsRemote } from "./azure-devops.js";

// Picks the issue tracker from origin's URL: Azure DevOps when it points there, GitHub otherwise.
export async function forgeOf(repoPath, on) {
  const azureDevOpsRepo = parseAzureDevOpsRemote(await readOriginUrl(repoPath, on));
  return azureDevOpsRepo ? azureDevOpsForge(azureDevOpsRepo, repoPath, on) : gitHubForge(repoPath, on);
}

export const isPullRequestFinished = (pr) => pr?.state === "MERGED" || pr?.state === "CLOSED";

export function checksSummary(steps) {
  if (!steps.length) return "none";
  if (steps.some((s) => s.outcome === "failure")) return "failure";
  if (steps.some((s) => s.outcome === "pending")) return "pending";
  return "success";
}
