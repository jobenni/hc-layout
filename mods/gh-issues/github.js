import { exec } from "herdr";

const ISSUE_BRANCH = /^issue-(\d+)(?:-|$)/;
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

// The GitHub account comes from the folder's mise env (GH_TOKEN), which only a shell
// that activated mise has; without it gh answers as the account hosts.yml marks active.
const GH_WITH_FOLDER_ENV = 'command -v mise >/dev/null 2>&1 && exec mise exec -- gh "$@"; exec gh "$@"';

async function run(command, args, cwd, on) {
  const [program, argv] = command === "gh" ? ["sh", ["-c", GH_WITH_FOLDER_ENV, "gh", ...args]] : [command, args];
  const result = await exec(program, argv, { cwd, on, timeout: 30000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || `${command} a échoué`);
  return result.stdout;
}

export function issueBranchNumber(branch) {
  const match = branch ? ISSUE_BRANCH.exec(branch) : null;
  return match ? Number(match[1]) : null;
}

export function issueBranchName(issue) {
  const slug = issue.title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug ? `issue-${issue.number}-${slug}` : `issue-${issue.number}`;
}

// The first entry of `git worktree list` is the main checkout; the others are its worktrees.
export async function readWorktrees(cwd, on) {
  const porcelain = await run("git", ["worktree", "list", "--porcelain"], cwd, on);
  return porcelain.split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    return {
      path: lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "",
      branch: lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null,
    };
  });
}

export async function readOpenIssues(cwd, on) {
  const json = await run("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,labels,assignees,updatedAt"], cwd, on);
  return JSON.parse(json);
}

const PR_FIELDS = "number,title,url,headRefName,state,isDraft,statusCheckRollup";

async function readPullRequestOf(branch, cwd, on) {
  const json = await run("gh", ["pr", "list", "--state", "all", "--head", branch, "--limit", "1", "--json", PR_FIELDS], cwd, on);
  return JSON.parse(json)[0] ?? null;
}

export async function readPullRequests(branches, cwd, on) {
  const unique = [...new Set(branches.filter(Boolean))];
  const found = await Promise.all(unique.map((branch) => readPullRequestOf(branch, cwd, on).catch(() => null)));
  return new Map(unique.map((branch, index) => [branch, found[index]]).filter(([, pr]) => pr));
}

export async function readViewerLogin(cwd, on) {
  return (await run("gh", ["api", "user", "--jq", ".login"], cwd, on)).trim();
}

export async function setSelfAssigned(issueNumber, isAssigned, cwd, on) {
  await run("gh", ["issue", "edit", String(issueNumber), isAssigned ? "--add-assignee" : "--remove-assignee", "@me"], cwd, on);
}

export function checkSteps(pr) {
  return (pr?.statusCheckRollup ?? []).map((check) => {
    const isStatusContext = check.__typename === "StatusContext";
    const name = isStatusContext ? check.context : check.workflowName ? `${check.workflowName} · ${check.name}` : check.name;
    const verdict = isStatusContext ? check.state : check.status === "COMPLETED" ? check.conclusion : check.status;
    return { name, url: isStatusContext ? check.targetUrl : check.detailsUrl, outcome: checkOutcome(verdict) };
  });
}

function checkOutcome(verdict) {
  if (!verdict || PENDING_STATES.has(verdict)) return "pending";
  if (FAILED_CONCLUSIONS.has(verdict)) return "failure";
  if (verdict === "SKIPPED" || verdict === "NEUTRAL" || verdict === "STALE") return "skipped";
  return "success";
}

export function checksSummary(steps) {
  if (!steps.length) return "none";
  if (steps.some((s) => s.outcome === "failure")) return "failure";
  if (steps.some((s) => s.outcome === "pending")) return "pending";
  return "success";
}

export async function defaultBaseRef(repoPath, on) {
  let ref;
  try { ref = (await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath, on)).trim(); }
  catch { return "HEAD"; }
  try { await run("git", ["fetch", "origin", ref.replace(/^origin\//, "")], repoPath, on); } catch {}
  return ref;
}

export async function branchExists(repoPath, branch, on) {
  const result = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath, on });
  return result.code === 0;
}

export async function addWorktree(repoPath, path, branch, baseRef, on) {
  const args = (await branchExists(repoPath, branch, on))
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, baseRef];
  await run("git", args, repoPath, on);
}
