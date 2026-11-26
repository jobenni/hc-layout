import { exec } from "herdr";

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
const PR_FIELDS = "number,title,url,headRefName,headRefOid,state,isDraft,statusCheckRollup";

// The GitHub account comes from the folder's mise env (GH_TOKEN), which only a shell
// that activated mise has; without it gh answers as the account hosts.yml marks active.
const GH_WITH_FOLDER_ENV = 'command -v mise >/dev/null 2>&1 && exec mise exec -- gh "$@"; exec gh "$@"';

async function runGh(args, cwd, on) {
  const result = await exec("sh", ["-c", GH_WITH_FOLDER_ENV, "gh", ...args], { cwd, on, timeout: 30000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || "gh a échoué");
  return result.stdout;
}

function checkSteps(statusCheckRollup) {
  return (statusCheckRollup ?? []).map((check) => {
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

const toAssignee = (user) => ({ id: user.login, name: user.login });

// "build\tRun tests\t2026-11-25T10:00:00.1234567Z error: ..." -> "error: ..."
const ciLogText = (line) => line.split("\t").slice(2).join("\t").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, "");
const actionsRunIds = (checks) => [...new Set(checks.map((c) => /\/actions\/runs\/(\d+)/.exec(c.url ?? "")?.[1]).filter(Boolean))];

export function gitHubForge(repoPath, on) {
  async function readPullRequestOf(branch) {
    const pr = JSON.parse(await runGh(["pr", "list", "--state", "all", "--head", branch, "--limit", "1", "--json", PR_FIELDS], repoPath, on))[0];
    if (!pr) return null;
    const { statusCheckRollup, ...rest } = pr;
    return { ...rest, checks: checkSteps(statusCheckRollup) };
  }

  return {
    name: "GitHub",
    readPullRequest: readPullRequestOf,
    hasSingleAssignee: false,
    workPrompt: (issue) => `Traite l'issue ${issue.url}`,

    async readOpenIssues() {
      const json = await runGh(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,assignees,updatedAt"], repoPath, on);
      return { issues: JSON.parse(json).map((issue) => ({ ...issue, assignees: issue.assignees.map(toAssignee) })), scope: null };
    },

    async readPullRequests(branches) {
      const unique = [...new Set(branches.filter(Boolean))];
      const found = await Promise.all(unique.map((branch) => readPullRequestOf(branch).catch(() => null)));
      return new Map(unique.map((branch, index) => [branch, found[index]]).filter(([, pr]) => pr));
    },

    async readIssue(number) {
      return JSON.parse(await runGh(["api", `repos/{owner}/{repo}/issues/${number}`, "--jq", "{title, url: .html_url}"], repoPath, on));
    },

    async createPullRequest({ branch, title, issueNumber, commits }) {
      const body = [issueNumber ? `Closes #${issueNumber}` : null, commits].filter(Boolean).join("\n\n");
      await runGh(["pr", "create", "--head", branch, "--title", title, "--body", body], repoPath, on);
    },

    // The last lines of each failed Actions run's failed steps.
    async readFailedCheckLogs(failedChecks, lineCount) {
      const logs = [];
      for (const runId of actionsRunIds(failedChecks)) {
        const out = await runGh(["run", "view", runId, "--log-failed"], repoPath, on).catch(() => "");
        const lines = out.split("\n").map(ciLogText).filter((l) => l.trim());
        if (lines.length) logs.push(lines.slice(-lineCount).join("\n"));
      }
      return logs;
    },

    async readViewer() {
      const login = (await runGh(["api", "user", "--jq", ".login"], repoPath, on)).trim();
      return { id: login, name: login };
    },

    async setSelfAssigned(issue, viewer, isAssigned) {
      await runGh(["issue", "edit", String(issue.number), isAssigned ? "--add-assignee" : "--remove-assignee", "@me"], repoPath, on);
      return isAssigned ? [...issue.assignees, viewer] : issue.assignees.filter((a) => a.id !== viewer.id);
    },
  };
}
