import { exec, hc, run, spaces, panes, agents, machines, readTextFile, appHome, notify } from "herdr";
import { readStore, changeRuns, updateRun, newId, slugOf, randomUuid, clockOf, ROUTINES_SPACE_NAME } from "./store.js";
import { compactStamp, clock } from "./schedule.js";
import { machineHome, machineAppDir, readMachineFiles, writeMachineFile } from "./machine-files.js";

// A routine runs on its machine: its space, tab, git, worktree, logs and summary all live there.
// The `-p` wrapper and the transcript reader are copied to another machine's benni/bin/ before its first run.
const MOD_DIR = `${appHome()}/mods/benni-routines`;
const TOOL_FILES = ["run-routine.sh", "routine.py"];
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

const logDirOn = async (machine) => `${await machineHome(machine)}/.cache/benni-routines`;
export const logPathOf = async (machine, runId) => `${await logDirOn(machine)}/${runId}.jsonl`;
const exitPathOf = async (machine, runId) => `${await logDirOn(machine)}/${runId}.exit`;

const copiedTools = new Set(); // machines whose benni/bin/ was brought up to date during this session

/** Where the wrapper and the reader are on `machine`: the mod's own folder here, benni/bin/ there. */
async function toolsDirOn(machine) {
  if (!machine) return MOD_DIR;
  const names = TOOL_FILES.map((file) => `benni/bin/${file}`);
  if (!copiedTools.has(machine)) {
    const theirs = await readMachineFiles(machine, names);
    for (const [index, file] of TOOL_FILES.entries()) {
      const mine = await readTextFile(`${MOD_DIR}/${file}`);
      if (mine !== null && theirs[names[index]] !== mine) await writeMachineFile(machine, names[index], mine, theirs[names[index]]);
    }
    copiedTools.add(machine);
  }
  return `${await machineAppDir(machine)}/benni/bin`;
}

async function git(args, cwd, on) {
  const result = await exec("git", args, { cwd, on, timeout: 60000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || `git ${args[0]} a échoué`);
  return result.stdout.trim();
}

async function readJson(machine, args) {
  const reader = `${await toolsDirOn(machine)}/routine.py`;
  const result = await exec("python3", ["-I", reader, ...args], { on: machine, timeout: READ_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `routine.py ${args[0]} a échoué`);
  return JSON.parse(result.stdout);
}

// Like the shipped New worktree dialog and gh-issues: Herdr's worktrees.directory, ~ being the machine's home.
async function worktreesDirectory(machine) {
  let directory = "~/.herdr/worktrees";
  try { directory = JSON.parse(await readTextFile(`${appHome()}/settings.json`) ?? "{}")?.worktrees?.directory ?? directory; } catch {}
  return directory.replace(/^~(?=$|\/)/, await machineHome(machine)).replace(/\/+$/, "");
}

async function defaultBaseRef(repo, on) {
  let ref;
  try { ref = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo, on); } catch { return "HEAD"; }
  try { await git(["fetch", "origin", ref.replace(/^origin\//, "")], repo, on); } catch {}
  return ref;
}

async function branchExists(repo, branch, on) {
  return (await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo, on })).code === 0;
}

/** A new `routine-<slug>-<AAAAMMJJ-HHMM>` worktree off origin/HEAD; returns it and where to start in it. */
async function createWorktree(machine, routine, startedAt) {
  const [top, common] = (await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], routine.folder, machine)).split("\n");
  const main = common.endsWith("/.git") ? common.slice(0, -5) : top;
  const repoName = main.replace(/\/+$/, "").split("/").pop();
  const stem = `routine-${slugOf(routine.name)}-${compactStamp((clockOf(machine) ?? clockOf(null)).toWall(startedAt))}`;
  let branch = stem;
  for (let n = 2; await branchExists(main, branch, machine); n++) branch = `${stem}-${n}`;
  const path = `${await worktreesDirectory(machine)}/${repoName}/${branch}`;
  await git(["worktree", "add", "-b", branch, path, await defaultBaseRef(main, machine)], main, machine);
  const inside = routine.folder.startsWith(`${top}/`) ? routine.folder.slice(top.length) : "";
  return { worktree: { path, branch, main }, cwd: `${path}${inside}` };
}

/** "<routine> · HH:MM" in the machine's own time. */
export function runTabName(machine, routine, startedAt) {
  return `${routine.name} · ${clock((clockOf(machine) ?? clockOf(null)).toWall(startedAt))}`;
}

function claudeArguments(routine, record) {
  const args = ["--session-id", record.sessionId, "--model", routine.model || "sonnet", "-n", record.tabName];
  if (routine.effort) args.push("--effort", routine.effort);
  if (routine.push && !routine.print) args.push("--remote-control", routine.name);
  return args;
}

const SPACE_WAIT_MS = 10000;
const SPACE_POLL_S = "0.5";
const routinesSpaceRequestedAt = new Map(); // machine -> when a run asked for its Routines space

const onMachine = (space, machine) => (space.machine ?? null) === machine;

function findRoutinesSpace(machine) {
  const { spaceId } = readStore(machine);
  return spaces().find((s) => s.id === spaceId && onMachine(s, machine))
    ?? spaces().find((s) => s.named && s.name === ROUTINES_SPACE_NAME && onMachine(s, machine)) ?? null;
}

// Two runs due in the same minute: the second waits for the space the first asked for.
async function routinesSpaceOnceRequested(machine) {
  while (!findRoutinesSpace(machine) && Date.now() - (routinesSpaceRequestedAt.get(machine) ?? 0) < SPACE_WAIT_MS) await exec("sleep", [SPACE_POLL_S]);
  return findRoutinesSpace(machine);
}

/** Starts one run of a routine on its machine, in its own tab of that machine's Routines space, never taking focus. */
export async function startRun(machine, routine, { manual = false, now = Date.now() } = {}) {
  const runId = newId("ru");
  const startedAt = now;
  const tabName = runTabName(machine, routine, startedAt);
  /** @type {import("./store.js").Run} */
  const record = {
    id: runId, routine: routine.id, routineName: routine.name, status: "running", startedAt, endedAt: null,
    print: Boolean(routine.print), tabName, tab: null, terminal: null, sessionId: randomUuid(), worktree: null,
    summary: "", error: "", missed: 0, sawWorking: false, manual,
  };
  await changeRuns(machine, (data) => { data.runs.unshift(record); });
  try {
    if (!routine.folder) throw new Error("aucun répertoire choisi");
    let cwd = routine.folder;
    if (routine.worktree) {
      const created = await createWorktree(machine, routine, startedAt);
      record.worktree = created.worktree;
      cwd = created.cwd;
      await updateRun(machine, runId, (r) => { r.worktree = created.worktree; });
    }
    const prompt = `${routine.prompt}${routine.push && !routine.print ? PUSH_INSTRUCTION : ""}`;
    const claudeArgs = claudeArguments(routine, record);
    const launch = routine.print
      ? { argv: ["sh", `${await toolsDirOn(machine)}/run-routine.sh`, await logPathOf(machine, runId), await exitPathOf(machine, runId), ...claudeArgs, "-p", "--output-format", "stream-json", "--verbose", prompt] }
      // tab.new appends `task` to argv: the wrapper hands it to claude as its first message.
      : { argv: ["sh", "-c", CLAUDE_VIA_LOGIN_SHELL, "sh", ...claudeArgs], task: prompt };
    const space = await routinesSpaceOnceRequested(machine);
    if (space) {
      run("tab.new", { space: space.id, name: tabName, folder: cwd, focus: false, ...launch });
    } else {
      routinesSpaceRequestedAt.set(machine, Date.now());
      run("space.new", { name: ROUTINES_SPACE_NAME, machine: machine ?? "", folder: cwd, tab: tabName, focus: false, ...launch });
    }
  } catch (error) {
    await updateRun(machine, runId, (r) => { r.status = "failed"; r.endedAt = Date.now(); r.error = `Lancement impossible : ${error?.message ?? error}`; });
  }
  return runId;
}

/** The tab a run opened on its machine, found by its unique name (run() returns nothing). */
function findRunTab(machine, record) {
  for (const space of spaces().filter((s) => onMachine(s, machine))) {
    const tab = space.tabs.find((t) => record.tab ? t.id === record.tab : t.name === record.tabName);
    if (tab) return { space, tab };
  }
  return null;
}

const machineReady = (machine) => machines().find((m) => m.name === machine)?.layout === "ready";

/**
 * Brings a machine's running runs up to date: their tab and terminal once they show, then whether they
 * ended. Another client may follow the same runs: each change applies only to a run still running.
 * Returns the runs that finished during this call.
 */
export async function followRunningRuns(machine) {
  // Right after Herdr starts, or while the machine is away, its tabs are not known.
  if (!machineReady(machine)) return [];
  const finished = [];
  for (const record of readStore(machine).runs.filter((r) => r.status === "running")) {
    const found = findRunTab(machine, record);
    if (found && (!record.tab || !record.terminal)) {
      const terminal = panes().find((p) => p.tab === found.tab.id && p.terminal)?.terminal ?? null;
      await changeRuns(machine, (data) => {
        const r = data.runs.find((x) => x.id === record.id);
        if (r) { r.tab = found.tab.id; r.terminal = terminal; }
        if (found.space.name === ROUTINES_SPACE_NAME || !data.spaceId) data.spaceId = found.space.id;
      });
      record.tab = found.tab.id;
      record.terminal = terminal;
    }
    const outcome = record.print ? await printOutcome(machine, record, Boolean(found)) : await interactiveOutcome(machine, record, Boolean(found));
    if (!outcome) continue;
    let ended = false;
    // Applied to the cache, then to the file read fresh: the file's pass decides (another client may have ended it).
    await updateRun(machine, record.id, (r) => {
      ended = r.status === "running";
      if (ended) Object.assign(r, outcome, { endedAt: Date.now() });
    });
    if (ended) finished.push({ ...record, ...outcome });
  }
  return finished;
}

async function printOutcome(machine, record, tabShown) {
  let exitText;
  try { exitText = await readTextFile(await exitPathOf(machine, record.id), { on: machine }); } catch { return null; }
  if (exitText === null) return lostTabOutcome(record, tabShown);
  const code = Number(exitText.trim());
  const result = await readJson(machine, ["result", await logPathOf(machine, record.id)]).catch(() => null);
  const summary = result?.result ?? "";
  if (result?.session_id) record.sessionId = result.session_id;
  if (code === 0 && result?.found && !result.is_error) return { status: "done", summary, sessionId: record.sessionId };
  return { status: "failed", summary, sessionId: record.sessionId, error: result?.found ? `Claude a fini en erreur (${result.subtype})` : `Claude s'est arrêté (code ${code})` };
}

async function interactiveOutcome(machine, record, tabShown) {
  const agent = record.terminal ? agents().find((a) => a.address === record.terminal) : null;
  if (agent?.status === "working" && !record.sawWorking) {
    record.sawWorking = true;
    await updateRun(machine, record.id, (r) => { r.sawWorking = true; });
  }
  // A background tab's agent that finishes shows "done"; one already looked at, "idle".
  if (agent && (agent.status === "done" || (record.sawWorking && RESTING_STATUSES.has(agent.status)))) {
    const read = await readJson(machine, ["summary", record.sessionId]).catch(() => null);
    return { status: "done", summary: read?.summary ?? "" };
  }
  // A turn short enough to start and end between two looks: idle, but Claude already answered.
  if (agent?.status === "idle" && Date.now() - record.startedAt > QUICK_TURN_GRACE_MS) {
    const read = await readJson(machine, ["summary", record.sessionId]).catch(() => null);
    if (read?.summary) return { status: "done", summary: read.summary };
  }
  return lostTabOutcome(record, tabShown);
}

function lostTabOutcome(record, tabShown) {
  if (tabShown) return null;
  if (record.tab) return { status: "failed", error: "Onglet fermé avant la fin" };
  if (Date.now() - record.startedAt > TAB_LOST_AFTER_MS) return { status: "failed", error: "L'onglet du run n'est jamais apparu" };
  return null;
}

/** Why a run's worktree must stay (uncommitted changes, commits not on origin), or null if it can go. */
export async function whyWorktreeStays(machine, worktree) {
  const exists = (await exec("test", ["-d", worktree.path], { on: machine })).code === 0;
  if (!exists) return null;
  if (await git(["--no-optional-locks", "status", "--porcelain"], worktree.path, machine)) return "modifications non commitées";
  const unpushed = Number(await git(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"], worktree.path, machine));
  if (unpushed > 0) return `${unpushed} commit${unpushed > 1 ? "s" : ""} absent${unpushed > 1 ? "s" : ""} de origin`;
  return null;
}

/** Removes a clean worktree and its branch. Returns why it was kept, or null once removed. */
export async function cleanWorktree(machine, worktree) {
  const why = await whyWorktreeStays(machine, worktree);
  if (why) return why;
  const exists = (await exec("test", ["-d", worktree.path], { on: machine })).code === 0;
  if (exists) await git(["worktree", "remove", worktree.path], worktree.main, machine);
  else await git(["worktree", "prune"], worktree.main, machine);
  if (await branchExists(worktree.main, worktree.branch, machine)) await git(["branch", "-D", worktree.branch], worktree.main, machine);
  return null;
}

export function closeRunTab(machine, record) {
  const found = findRunTab(machine, record);
  if (found) run("tab.close", { id: found.tab.id, confirmed: true });
}

export async function removeRunFiles(machine, record) {
  if (record.print) await exec("rm", ["-f", await logPathOf(machine, record.id), await exitPathOf(machine, record.id)], { on: machine });
}

/** Beyond a routine's kept count, its oldest finished runs go: tab, entry, files, and a clean worktree. */
export async function purgeOldRuns(machine, routine) {
  const own = readStore(machine).runs.filter((r) => r.routine === routine.id).sort((a, b) => b.startedAt - a.startedAt);
  const extra = own.slice(Math.max(1, Number(routine.keep) || 1)).filter((r) => r.status !== "running");
  if (!extra.length) return;
  const gone = new Set(extra.map((r) => r.id));
  for (const record of extra) closeRunTab(machine, record);
  await changeRuns(machine, (data) => { data.runs = data.runs.filter((r) => !gone.has(r.id)); });
  for (const record of extra) {
    await removeRunFiles(machine, record).catch(() => {});
    if (!record.worktree) continue;
    const kept = await cleanWorktree(machine, record.worktree).catch((error) => error?.message ?? String(error));
    if (kept) notify({ title: `Worktree gardé : ${record.worktree.branch}`, body: `Run purgé de « ${record.routineName} », worktree conservé (${kept}) : ${record.worktree.path}`, level: "warning" });
  }
}

/** Puts the user on a run's tab. */
export function focusRunTab(machine, record) {
  const found = findRunTab(machine, record);
  if (!found) return false;
  run("space.select", { id: found.space.id });
  run("tab.select", { id: found.tab.id });
  return true;
}

/** Reopens a finished `-p` run as an interactive session in its own tab. */
export async function resumeInTab(machine, record) {
  const found = findRunTab(machine, record);
  if (!found || !record.sessionId) return "onglet introuvable";
  const terminal = record.terminal ?? panes().find((p) => p.tab === found.tab.id && p.terminal)?.terminal;
  if (!terminal) return "terminal introuvable";
  focusRunTab(machine, record);
  const result = await hc(["send", terminal, `claude --resume ${record.sessionId}`]);
  return result.code === 0 ? null : (result.stderr || result.stdout).trim() || "hc send a échoué";
}
