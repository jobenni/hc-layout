import { exec, hc, run, spaces, panes, agents, machines, readTextFile, appHome, home, notify } from "herdr";
import { readStore, updateStore, updateRun, newId, slugOf, randomUuid, ROUTINES_SPACE_NAME } from "./store.js";
import { compactStamp, clock } from "./schedule.js";

const MOD_DIR = `${appHome()}/mods/benni-routines`;
const RUNNER = `${MOD_DIR}/run-routine.sh`;
const READER = `${MOD_DIR}/routine.py`;
const LOG_DIR = `${home()}/.cache/benni-routines`;
const READ_TIMEOUT_MS = 20000;
const TAB_LOST_AFTER_MS = 60000;
const RESTING_STATUSES = new Set(["idle", "done"]);
const QUICK_TURN_GRACE_MS = 20000;
// Through the user's own shell, as gh-issues does, so a `claude` function or alias in their rc file applies.
const CLAUDE_VIA_LOGIN_SHELL = [
  'case "${SHELL##*/}" in',
  '  fish) exec "$SHELL" -c \'claude $argv\' -- "$@" ;;',
  '  bash|zsh) exec "$SHELL" -ic \'claude "$@"\' claude "$@" ;;',
  "esac",
  'exec claude "$@"',
].join("\n");
const PUSH_INSTRUCTION = "\n\nQuand tu as terminé, envoie une notification push avec l'outil PushNotification : "
  + "une seule ligne de moins de 200 caractères qui résume ce que tu as fait ou trouvé, en commençant par ce sur quoi agir.";

export const logPathOf = (runId) => `${LOG_DIR}/${runId}.jsonl`;
const exitPathOf = (runId) => `${LOG_DIR}/${runId}.exit`;

async function git(args, cwd) {
  const result = await exec("git", args, { cwd, timeout: 60000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || `git ${args[0]} a échoué`);
  return result.stdout.trim();
}

async function readJson(args) {
  const result = await exec("python3", ["-I", READER, ...args], { timeout: READ_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `routine.py ${args[0]} a échoué`);
  return JSON.parse(result.stdout);
}

// Like the shipped New worktree dialog and gh-issues: Herdr's worktrees.directory, ~ expanded.
async function worktreesDirectory() {
  let directory = "~/.herdr/worktrees";
  try { directory = JSON.parse(await readTextFile(`${appHome()}/settings.json`) ?? "{}")?.worktrees?.directory ?? directory; } catch {}
  return directory.replace(/^~(?=$|\/)/, home()).replace(/\/+$/, "");
}

async function defaultBaseRef(repo) {
  let ref;
  try { ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo); } catch { return "HEAD"; }
  try { await git(["fetch", "origin", ref.replace(/^origin\//, "")], repo); } catch {}
  return ref;
}

async function branchExists(repo, branch) {
  return (await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo })).code === 0;
}

/** A new `routine-<slug>-<AAAAMMJJ-HHMM>` worktree off origin/HEAD; returns it and where to start in it. */
async function createWorktree(routine, startedAt) {
  const [top, common] = (await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], routine.folder)).split("\n");
  const main = common.endsWith("/.git") ? common.slice(0, -5) : top;
  const repoName = main.replace(/\/+$/, "").split("/").pop();
  const stem = `routine-${slugOf(routine.name)}-${compactStamp(new Date(startedAt))}`;
  let branch = stem;
  for (let n = 2; await branchExists(main, branch); n++) branch = `${stem}-${n}`;
  const path = `${await worktreesDirectory()}/${repoName}/${branch}`;
  await git(["worktree", "add", "-b", branch, path, await defaultBaseRef(main)], main);
  const inside = routine.folder.startsWith(`${top}/`) ? routine.folder.slice(top.length) : "";
  return { worktree: { path, branch, main }, cwd: `${path}${inside}` };
}

function claudeArguments(routine, run) {
  const args = ["--session-id", run.sessionId, "--model", routine.model || "sonnet", "-n", `${routine.name} · ${clock(new Date(run.startedAt))}`];
  if (routine.effort) args.push("--effort", routine.effort);
  if (routine.push && !routine.print) args.push("--remote-control", routine.name);
  return args;
}

function routinesSpace(store) {
  return spaces().find((s) => s.id === store.spaceId) ?? null;
}

/** Starts one run of a routine in its own tab of the Routines space, never taking focus. */
export async function startRun(routine, { manual = false, now = Date.now() } = {}) {
  const runId = newId("ru");
  const startedAt = now;
  const tabName = `${routine.name} · ${clock(new Date(startedAt))}`;
  /** @type {import("./store.js").Run} */
  const record = {
    id: runId, routine: routine.id, routineName: routine.name, status: "running", startedAt, endedAt: null,
    print: Boolean(routine.print), tabName, tab: null, terminal: null, sessionId: randomUuid(), worktree: null,
    summary: "", error: "", missed: 0, sawWorking: false, manual,
  };
  updateStore((store) => { store.runs.unshift(record); });
  try {
    if (!routine.folder) throw new Error("aucun répertoire choisi");
    let cwd = routine.folder;
    if (routine.worktree) {
      const created = await createWorktree(routine, startedAt);
      record.worktree = created.worktree;
      cwd = created.cwd;
      updateRun(runId, (r) => { r.worktree = created.worktree; });
    }
    const prompt = `${routine.prompt}${routine.push && !routine.print ? PUSH_INSTRUCTION : ""}`;
    const claudeArgs = claudeArguments(routine, record);
    const launch = routine.print
      ? { argv: ["sh", RUNNER, logPathOf(runId), exitPathOf(runId), ...claudeArgs, "-p", "--output-format", "stream-json", "--verbose", prompt] }
      // tab.new appends `task` to argv: the wrapper hands it to claude as its first message.
      : { argv: ["sh", "-c", CLAUDE_VIA_LOGIN_SHELL, "sh", ...claudeArgs], task: prompt };
    const space = routinesSpace(readStore());
    if (space) run("tab.new", { space: space.id, name: tabName, folder: cwd, focus: false, ...launch });
    else run("space.new", { name: ROUTINES_SPACE_NAME, folder: cwd, tab: tabName, focus: false, ...launch });
  } catch (error) {
    updateRun(runId, (r) => { r.status = "failed"; r.endedAt = Date.now(); r.error = `Lancement impossible : ${error?.message ?? error}`; });
  }
  return runId;
}

/** The tab a run opened, found by its unique name (run() returns nothing). */
function findRunTab(record) {
  for (const space of spaces()) {
    const tab = space.tabs.find((t) => record.tab ? t.id === record.tab : t.name === record.tabName);
    if (tab) return { space, tab };
  }
  return null;
}

/**
 * Brings running runs up to date: their tab and terminal once they show, then whether they ended.
 * Returns the runs that finished during this call.
 */
export async function followRunningRuns() {
  const finished = [];
  for (const record of readStore().runs.filter((r) => r.status === "running")) {
    const found = findRunTab(record);
    if (found && (!record.tab || !record.terminal)) {
      const terminal = panes().find((p) => p.tab === found.tab.id && p.terminal)?.terminal ?? null;
      updateStore((store) => {
        const r = store.runs.find((x) => x.id === record.id);
        if (r) { r.tab = found.tab.id; r.terminal = terminal; }
        if (found.space.name === ROUTINES_SPACE_NAME || !store.spaceId) store.spaceId = found.space.id;
      });
      record.tab = found.tab.id;
      record.terminal = terminal;
    }
    const outcome = record.print ? await printOutcome(record, Boolean(found)) : await interactiveOutcome(record, Boolean(found));
    if (!outcome) continue;
    updateRun(record.id, (r) => Object.assign(r, outcome, { endedAt: Date.now() }));
    finished.push({ ...record, ...outcome });
  }
  return finished;
}

async function printOutcome(record, tabShown) {
  const exitText = await readTextFile(exitPathOf(record.id)).catch(() => null);
  if (exitText === null) return lostTabOutcome(record, tabShown);
  const code = Number(exitText.trim());
  const result = await readJson(["result", logPathOf(record.id)]).catch(() => null);
  const summary = result?.result ?? "";
  if (result?.session_id) record.sessionId = result.session_id;
  if (code === 0 && result?.found && !result.is_error) return { status: "done", summary, sessionId: record.sessionId };
  return { status: "failed", summary, sessionId: record.sessionId, error: result?.found ? `Claude a fini en erreur (${result.subtype})` : `Claude s'est arrêté (code ${code})` };
}

async function interactiveOutcome(record, tabShown) {
  const agent = record.terminal ? agents().find((a) => a.address === record.terminal) : null;
  if (agent?.status === "working" && !record.sawWorking) {
    record.sawWorking = true;
    updateRun(record.id, (r) => { r.sawWorking = true; });
  }
  // A background tab's agent that finishes shows "done"; one already looked at, "idle".
  if (agent && (agent.status === "done" || (record.sawWorking && RESTING_STATUSES.has(agent.status)))) {
    const read = await readJson(["summary", record.sessionId]).catch(() => null);
    return { status: "done", summary: read?.summary ?? "" };
  }
  // A turn short enough to start and end between two looks: idle, but Claude already answered.
  if (agent?.status === "idle" && Date.now() - record.startedAt > QUICK_TURN_GRACE_MS) {
    const read = await readJson(["summary", record.sessionId]).catch(() => null);
    if (read?.summary) return { status: "done", summary: read.summary };
  }
  return lostTabOutcome(record, tabShown);
}

function lostTabOutcome(record, tabShown) {
  // Right after Herdr starts, this computer's tabs are not known yet.
  if (tabShown || machines().find((m) => m.name === null)?.layout !== "ready") return null;
  if (record.tab) return { status: "failed", error: "Onglet fermé avant la fin" };
  if (Date.now() - record.startedAt > TAB_LOST_AFTER_MS) return { status: "failed", error: "L'onglet du run n'est jamais apparu" };
  return null;
}

/** Why a run's worktree must stay (uncommitted changes, commits not on origin), or null if it can go. */
export async function whyWorktreeStays(worktree) {
  const exists = (await exec("test", ["-d", worktree.path])).code === 0;
  if (!exists) return null;
  if (await git(["--no-optional-locks", "status", "--porcelain"], worktree.path)) return "modifications non commitées";
  const unpushed = Number(await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"], worktree.path));
  if (unpushed > 0) return `${unpushed} commit${unpushed > 1 ? "s" : ""} absent${unpushed > 1 ? "s" : ""} de origin`;
  return null;
}

/** Removes a clean worktree and its branch. Returns why it was kept, or null once removed. */
export async function cleanWorktree(worktree) {
  const why = await whyWorktreeStays(worktree);
  if (why) return why;
  const exists = (await exec("test", ["-d", worktree.path])).code === 0;
  if (exists) await git(["worktree", "remove", worktree.path], worktree.main);
  else await git(["worktree", "prune"], worktree.main);
  if (await branchExists(worktree.main, worktree.branch)) await git(["branch", "-D", worktree.branch], worktree.main);
  return null;
}

export function closeRunTab(record) {
  const found = findRunTab(record);
  if (found) run("tab.close", { id: found.tab.id, confirmed: true });
}

export async function removeRunFiles(record) {
  if (record.print) await exec("rm", ["-f", logPathOf(record.id), exitPathOf(record.id)]);
}

/** Beyond a routine's kept count, its oldest finished runs go: tab, entry, files, and a clean worktree. */
export async function purgeOldRuns(routine) {
  const own = readStore().runs.filter((r) => r.routine === routine.id).sort((a, b) => b.startedAt - a.startedAt);
  const extra = own.slice(Math.max(1, Number(routine.keep) || 1)).filter((r) => r.status !== "running");
  for (const record of extra) {
    closeRunTab(record);
    updateStore((store) => { store.runs = store.runs.filter((r) => r.id !== record.id); });
    await removeRunFiles(record).catch(() => {});
    if (!record.worktree) continue;
    const kept = await cleanWorktree(record.worktree).catch((error) => error?.message ?? String(error));
    if (kept) notify({ title: `Worktree gardé : ${record.worktree.branch}`, body: `Run purgé de « ${record.routineName} », worktree conservé (${kept}) : ${record.worktree.path}`, level: "warning" });
  }
}

/** Puts the user on a run's tab. */
export function focusRunTab(record) {
  const found = findRunTab(record);
  if (!found) return false;
  run("space.select", { id: found.space.id });
  run("tab.select", { id: found.tab.id });
  return true;
}

/** Reopens a finished `-p` run as an interactive session in its own tab. */
export async function resumeInTab(record) {
  const found = findRunTab(record);
  if (!found || !record.sessionId) return "onglet introuvable";
  const terminal = record.terminal ?? panes().find((p) => p.tab === found.tab.id && p.terminal)?.terminal;
  if (!terminal) return "terminal introuvable";
  focusRunTab(record);
  const result = await hc(["send", terminal, `claude --resume ${record.sessionId}`]);
  return result.code === 0 ? null : (result.stderr || result.stdout).trim() || "hc send a échoué";
}
