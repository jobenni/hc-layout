import { exec } from "herdr";

const API = "api-version=7.1";
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const BUILD_POLICY_TYPE = "0609b952-1397-4640-95ec-e00a01b2c241";
const AUTH_LIFETIME_MS = 30 * 60 * 1000;
const ISSUE_LIMIT = 100;
const CLOSED_STATE_CATEGORIES = new Set(["Completed", "Removed"]);
const PR_STATE = { active: "OPEN", completed: "MERGED", abandoned: "CLOSED" };
const POLICY_OUTCOME = { approved: "success", rejected: "failure", broken: "failure", running: "pending", queued: "pending", notApplicable: "skipped" };
const STATUS_OUTCOME = { succeeded: "success", failed: "failure", error: "failure", pending: "pending", notApplicable: "skipped" };
const NO_ACCESS = "Pas d'accès Azure DevOps : lance `az login`, ou mets ton PAT dans ~/.claude/ado.conf (PAT=…)";

// Same lookup as the ado skill's ado.py: the az CLI's token first, else the PAT of
// ~/.claude/ado.conf, else ~/.claude/ado-pat. Prints the Authorization header's value,
// or exits 3 when there is none. Under mise when it exists, since az often comes from it.
const AUTH_HEADER_LOOKUP = [
  `if command -v az >/dev/null 2>&1; then`,
  `  token=$(az account get-access-token --resource ${ADO_RESOURCE} --query accessToken -o tsv 2>/dev/null)`,
  `  if [ -n "$token" ]; then printf 'Bearer %s' "$token"; exit 0; fi`,
  `fi`,
  `pat=$(sed -n 's/^PAT=//p' "\${ADO_CONFIG_FILE:-$HOME/.claude/ado.conf}" 2>/dev/null | head -n 1 | tr -d '[:space:]')`,
  `[ -n "$pat" ] || pat=$(tr -d '[:space:]' < "\${ADO_PAT_FILE:-$HOME/.claude/ado-pat}" 2>/dev/null)`,
  `[ -n "$pat" ] || exit 3`,
  `printf 'Basic %s' "$(printf ':%s' "$pat" | base64 | tr -d '\\n')"`,
].join("\n");
const UNDER_MISE = 'command -v mise >/dev/null 2>&1 && exec mise exec -- sh -c "$1"; exec sh -c "$1"';

const ADO_REMOTES = [
  /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/,
  /^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/,
  /^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/,
];

export function parseAzureDevOpsRemote(url) {
  for (const pattern of ADO_REMOTES) {
    const match = pattern.exec(url);
    if (match) {
      const [org, project, repo] = match.slice(1).map((part) => decodeURIComponent(part));
      return { org, project, repo: repo.replace(/\.git$/, "") };
    }
  }
  return null;
}

// One lookup per machine at a time: the requests of a refresh share it.
const authHeaderByMachine = new Map();

async function lookUpAuthHeader(on, cwd) {
  const result = await exec("sh", ["-c", UNDER_MISE, "sh", AUTH_HEADER_LOOKUP], { cwd, on, timeout: 30000 });
  const header = result.stdout.trim();
  if (result.code !== 0 || !header) throw new Error(NO_ACCESS);
  return header;
}

function authHeader(on, cwd) {
  const machine = on ?? "";
  const cached = authHeaderByMachine.get(machine);
  if (cached && cached.expiresAt > Date.now()) return cached.header;
  const header = lookUpAuthHeader(on, cwd);
  authHeaderByMachine.set(machine, { header, expiresAt: Date.now() + AUTH_LIFETIME_MS });
  header.catch(() => { if (authHeaderByMachine.get(machine)?.header === header) authHeaderByMachine.delete(machine); });
  return header;
}

const segment = (name) => encodeURIComponent(name);
const DESCRIPTION_LIMIT = 4000;
// "2026-11-26T10:49:22.5416538Z ##[error]..." -> "##[error]..."
const buildLogText = (line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, "");
const buildIds = (checks) => [...new Set(checks.map((c) => /[?&]buildId=(\d+)/.exec(c.url ?? "")?.[1]).filter(Boolean))];
const wiqlString = (text) => `'${text.replace(/'/g, "''")}'`;

function checkName(policy) {
  const name = policy.configuration?.settings?.displayName || policy.context?.buildDefinitionName || policy.configuration?.type?.displayName || "Build";
  return policy.context?.isExpired ? `${name} (expiré)` : name;
}

// Keeps each status context's latest post: ADO keeps one per PR iteration.
function latestStatuses(statuses) {
  const byContext = new Map();
  for (const status of statuses) {
    const key = `${status.context?.genre ?? ""}/${status.context?.name ?? ""}`;
    const previous = byContext.get(key);
    if (!previous || (status.iterationId ?? 0) >= (previous.iterationId ?? 0)) byContext.set(key, status);
  }
  return [...byContext.values()];
}

export function azureDevOpsForge({ org, project, repo }, repoPath, on) {
  const projectUrl = `https://dev.azure.com/${segment(org)}/${segment(project)}`;
  const repoApi = `${projectUrl}/_apis/git/repositories/${segment(repo)}`;
  const closedStatesByType = new Map();

  async function request(url, { method = "GET", body, contentType = "application/json" } = {}) {
    const headers = { Authorization: await authHeader(on, repoPath), Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = contentType;
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    // A refused token gets a 401, or a sign-in page (203, 404, even 200) instead of JSON.
    if (response.status === 401 || response.status === 403 || response.status === 203 || json === null) {
      authHeaderByMachine.delete(on ?? "");
      throw new Error(NO_ACCESS);
    }
    if (!response.ok) throw new Error(json?.message ?? `Azure DevOps a répondu ${response.status}`);
    return json;
  }

  async function currentIteration() {
    const json = await request(`${projectUrl}/_apis/work/teamsettings/iterations?$timeframe=current&${API}`);
    return json.value?.[0] ?? null;
  }

  async function closedStatesOf(type) {
    if (!closedStatesByType.has(type)) {
      const json = await request(`${projectUrl}/_apis/wit/workitemtypes/${segment(type)}/states?${API}`);
      closedStatesByType.set(type, new Set(json.value.filter((s) => CLOSED_STATE_CATEGORIES.has(s.category)).map((s) => s.name)));
    }
    return closedStatesByType.get(type);
  }

  async function readWorkItems(ids) {
    if (!ids.length) return [];
    const fields = "System.Title,System.State,System.WorkItemType,System.AssignedTo";
    const json = await request(`${projectUrl}/_apis/wit/workitems?ids=${ids.join(",")}&fields=${fields}&errorPolicy=omit&${API}`);
    const byId = new Map(json.value.filter(Boolean).map((item) => [item.id, item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function toIssue(item) {
    const assignee = item.fields["System.AssignedTo"];
    return {
      number: item.id,
      title: item.fields["System.Title"],
      url: `${projectUrl}/_workitems/edit/${item.id}`,
      assignees: assignee ? [{ id: assignee.id, name: assignee.displayName ?? assignee.uniqueName }] : [],
    };
  }

  async function readChecks(pr) {
    const artifact = `vstfs:///CodeReview/CodeReviewId/${pr.repository.project.id}/${pr.pullRequestId}`;
    const [policies, statuses] = await Promise.all([
      request(`${projectUrl}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifact)}&api-version=7.1-preview.1`).catch(() => ({ value: [] })),
      request(`${repoApi}/pullRequests/${pr.pullRequestId}/statuses?${API}`).catch(() => ({ value: [] })),
    ]);
    const prUrl = pullRequestUrl(pr.pullRequestId);
    const builds = policies.value.filter((p) => p.configuration?.type?.id === BUILD_POLICY_TYPE).map((policy) => ({
      name: checkName(policy),
      url: policy.context?.buildId ? `${projectUrl}/_build/results?buildId=${policy.context.buildId}` : prUrl,
      outcome: policy.context?.isExpired ? "skipped" : POLICY_OUTCOME[policy.status] ?? "pending",
    }));
    const others = latestStatuses(statuses.value).filter((s) => STATUS_OUTCOME[s.state]).map((status) => ({
      name: [status.context?.genre, status.context?.name].filter(Boolean).join(" · ") || status.description || "Statut",
      url: status.targetUrl || prUrl,
      outcome: STATUS_OUTCOME[status.state],
    }));
    return [...builds, ...others];
  }

  const pullRequestUrl = (id) => `${projectUrl}/_git/${segment(repo)}/pullrequest/${id}`;

  async function readPullRequestOf(branch) {
    const sourceRef = encodeURIComponent(`refs/heads/${branch}`);
    const json = await request(`${repoApi}/pullrequests?searchCriteria.sourceRefName=${sourceRef}&searchCriteria.status=all&$top=10&${API}`);
    const pr = json.value.find((p) => p.status === "active") ?? json.value[0];
    if (!pr) return null;
    const state = PR_STATE[pr.status] ?? "OPEN";
    return {
      number: pr.pullRequestId,
      title: pr.title,
      url: pullRequestUrl(pr.pullRequestId),
      headRefName: branch,
      headRefOid: pr.lastMergeSourceCommit?.commitId ?? null,
      state,
      isDraft: Boolean(pr.isDraft),
      checks: state === "OPEN" ? await readChecks(pr).catch(() => []) : [],
    };
  }

  async function readFailedBuildLogs(buildId, lineCount) {
    const buildApi = `${projectUrl}/_apis/build/builds/${buildId}`;
    const [timeline, logList] = await Promise.all([request(`${buildApi}/timeline?${API}`), request(`${buildApi}/logs?${API}`)]);
    const lineCounts = new Map(logList.value.map((log) => [log.id, log.lineCount ?? 0]));
    const failedSteps = timeline.records.filter((r) => r.type === "Task" && r.result === "failed" && r.log?.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const logs = [];
    for (const step of failedSteps) {
      const startLine = Math.max(1, (lineCounts.get(step.log.id) ?? 0) - lineCount + 1);
      const log = await request(`${buildApi}/logs/${step.log.id}?startLine=${startLine}&${API}`).catch(() => ({ value: [] }));
      const lines = log.value.map(buildLogText).filter((l) => l.trim());
      if (lines.length) logs.push(`${step.name}\n${lines.slice(-lineCount).join("\n")}`);
    }
    return logs;
  }

  return {
    name: "Azure DevOps",
    readPullRequest: readPullRequestOf,
    hasSingleAssignee: true,
    workPrompt: (issue) => `Traite le work item Azure DevOps ${issue.url}`,

    // The default team's current sprint, its backlog items and bugs that are not done.
    async readOpenIssues() {
      const iteration = await currentIteration();
      if (!iteration) return { issues: [], scope: "aucun sprint en cours" };
      const query = [
        "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project",
        `AND [System.IterationPath] = ${wiqlString(iteration.path)}`,
        "AND ([System.WorkItemType] IN GROUP 'Microsoft.RequirementCategory' OR [System.WorkItemType] IN GROUP 'Microsoft.BugCategory')",
        "ORDER BY [System.ChangedDate] DESC",
      ].join(" ");
      const found = await request(`${projectUrl}/_apis/wit/wiql?$top=200&${API}`, { method: "POST", body: { query } });
      const items = await readWorkItems(found.workItems.map((w) => w.id));
      const closed = new Map(await Promise.all([...new Set(items.map((i) => i.fields["System.WorkItemType"]))]
        .map(async (type) => [type, await closedStatesOf(type)])));
      const open = items.filter((i) => !closed.get(i.fields["System.WorkItemType"]).has(i.fields["System.State"]));
      return { issues: open.slice(0, ISSUE_LIMIT).map(toIssue), scope: iteration.name };
    },

    async readPullRequests(branches) {
      const unique = [...new Set(branches.filter(Boolean))];
      const found = await Promise.all(unique.map((branch) => readPullRequestOf(branch).catch(() => null)));
      return new Map(unique.map((branch, index) => [branch, found[index]]).filter(([, pr]) => pr));
    },

    async readIssue(number) {
      const item = await request(`${projectUrl}/_apis/wit/workitems/${number}?fields=System.Title&${API}`);
      return { title: item.fields["System.Title"], url: `${projectUrl}/_workitems/edit/${item.id}` };
    },

    // Into the repo's default branch, linked to the work item (the board shows it, completion can close it).
    async createPullRequest({ branch, title, issueNumber, commits }) {
      const { defaultBranch } = await request(`${repoApi}?${API}`);
      await request(`${repoApi}/pullrequests?${API}`, {
        method: "POST",
        body: {
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: defaultBranch,
          title,
          description: (commits ?? "").slice(0, DESCRIPTION_LIMIT),
          workItemRefs: issueNumber ? [{ id: String(issueNumber) }] : [],
        },
      });
    },

    // The last lines of each failed build's failed steps.
    async readFailedCheckLogs(failedChecks, lineCount) {
      const logs = await Promise.all(buildIds(failedChecks).map((id) => readFailedBuildLogs(id, lineCount).catch(() => [])));
      return logs.flat();
    },

    async readViewer() {
      const json = await request(`https://dev.azure.com/${segment(org)}/_apis/connectionData`);
      const user = json.authenticatedUser;
      return { id: user.id, name: user.providerDisplayName, uniqueName: user.properties?.Account?.$value };
    },

    // A work item has one assignee: taking it replaces whoever had it.
    async setSelfAssigned(issue, viewer, isAssigned) {
      const patch = [{ op: "add", path: "/fields/System.AssignedTo", value: isAssigned ? viewer.uniqueName : "" }];
      await request(`${projectUrl}/_apis/wit/workitems/${issue.number}?${API}`, { method: "PATCH", body: patch, contentType: "application/json-patch+json" });
      return isAssigned ? [viewer] : [];
    },
  };
}
