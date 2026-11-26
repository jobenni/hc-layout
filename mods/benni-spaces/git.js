import { exec } from "herdr";

const ISSUE_BRANCH = /^issue-(\d+)(?:-|$)/;

export async function runGit(args, cwd, on) {
  const result = await exec("git", args, { cwd, on, timeout: 30000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || "git a échoué");
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

export async function readOriginUrl(repoPath, on) {
  const result = await exec("git", ["remote", "get-url", "origin"], { cwd: repoPath, on });
  return result.code === 0 ? result.stdout.trim() : "";
}

// The first entry of `git worktree list` is the main checkout; the others are its worktrees.
export async function readWorktrees(cwd, on) {
  const porcelain = await runGit(["worktree", "list", "--porcelain"], cwd, on);
  return porcelain.split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    return {
      path: lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "",
      branch: lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null,
      isFolderMissing: lines.some((l) => l.startsWith("prunable")),
    };
  });
}

export async function defaultBaseRef(repoPath, on) {
  let ref;
  try { ref = (await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repoPath, on)).trim(); }
  catch { return "HEAD"; }
  try { await runGit(["fetch", "origin", ref.replace(/^origin\//, "")], repoPath, on); } catch {}
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
  await runGit(args, repoPath, on);
}

export async function hasUncommittedChanges(worktreePath, on) {
  return Boolean((await runGit(["--no-optional-locks", "status", "--porcelain"], worktreePath, on)).trim());
}

// Removes the worktree, then its branch: forced when it still points at the PR's head (a squash
// merge leaves it unmerged in git's eyes), else only if git finds it merged. Returns why the branch
// was kept, or null once it is deleted.
export async function removeWorktreeAndBranch(repoPath, worktree, pr, on) {
  if (worktree.isFolderMissing) await runGit(["worktree", "prune"], repoPath, on);
  else await runGit(["worktree", "remove", worktree.path], repoPath, on);
  const head = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`], { cwd: repoPath, on });
  if (head.code !== 0) return null;
  const isPullRequestHead = head.stdout.trim() === pr.headRefOid;
  const deleted = await exec("git", ["branch", isPullRequestHead ? "-D" : "-d", worktree.branch], { cwd: repoPath, on });
  return deleted.code === 0 ? null : "commits absents de la PR";
}
