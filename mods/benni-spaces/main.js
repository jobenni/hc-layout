// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, machines, panes, agents, terminals, setAgentOrder, run, openOverlay, notify, exec, hc, theme, shared, setShared, watchFolder, window, layout, readTextFile, appHome, checking, updates } from "herdr";

// The layout's update check, repeated in benni-spaces and benni-settings (Herdr refuses imports between mods).
// install.sh records the commit it installed in <appHome>/hc-layout.json; shared("benni.update") = { installed, latest }.
// The channel (shared("benni.channel")) picks the branch: Stable follows main, Canary the work in progress.
const LAYOUT_REPO = "https://github.com/jobenni/hc-layout.git";
const UPDATE_KEY = "benni.update";
const CHANNEL_KEY = "benni.channel";
const CHANNEL_BRANCHES = { stable: "main", canary: "canary" };

const chosenChannel = () => (shared(CHANNEL_KEY) === "canary" ? "canary" : "stable");
const chosenBranch = () => CHANNEL_BRANCHES[chosenChannel()];

async function readInstalledCommit() {
  const text = await readTextFile(`${appHome()}/hc-layout.json`);
  try { return JSON.parse(text ?? "")?.commit || null; } catch { return null; }
}

async function readLatestCommit(branch) {
  const result = await exec("git", ["ls-remote", LAYOUT_REPO, `refs/heads/${branch}`], { timeout: 20000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "GitHub ne répond pas");
  const commit = result.stdout.split(/\s/)[0];
  if (!commit) throw new Error(`la branche ${branch} n'existe pas sur GitHub`);
  return commit;
}
const UPDATE_FIRST_CHECK_DELAY = 15000;
const UPDATE_CHECK_INTERVAL = 60 * 1000;
const UPDATE_NOTICE_DURATION = 10 * 1000;


function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// The rail's way back. workspace-chrome hides its toggle on the macOS rail and leaves it to the
// agents list, which this layout doesn't have; same widths and memory as the shipped toggle.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
const RAIL_SESSION_CELL = 32;
const RAIL_SESSION_AVATAR = 18;
// Session rows line up with the space row above: icon under its avatar column, name under its name.
const SESSION_ICON = 14;
const SESSION_GAP = 8;
const SESSION_INDENT = 35;
const WORKTREE_ICON_INDENT = SESSION_INDENT - 8;
const NESTED_SESSION_INDENT = SESSION_INDENT + SESSION_ICON + SESSION_GAP;
const sessionIndent = (tree) => (tree ? NESTED_SESSION_INDENT : SESSION_INDENT);
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
const routinesMark = (size, t) => h_flex().size(size).flex_none().rounded(5).bg(t.raised).items_center().justify_center()
  .child(svg("mods/workspace-chrome/clock.svg").size(size * 0.67).text_color(t.muted));
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

// A session's ticket: its branch as gh-issues names it (issue-42-...), else its tab (#42), else its title (... #42).
const ISSUE_BRANCH = /^issue-(\d+)(?:-|$)/;
const ISSUE_TAB = /^#(\d+)$/;
const ISSUE_IN_TITLE = /#(\d+)\b/;
function issueNumber(branch, tabName, sessionName) {
  const match = ISSUE_BRANCH.exec(branch ?? "") ?? ISSUE_TAB.exec(tabName ?? "") ?? ISSUE_IN_TITLE.exec(sessionName ?? "");
  return match ? Number(match[1]) : null;
}
const SESSION_GIT_TTL = 60000;
// Sessions shown as cards above the spaces: those that need you, then those at work.
const CARDED_STATUSES = ["blocked", "working"];
// Sessions at rest stay carded this long after their last change.
const RESTING_STATUSES = ["done", "idle"];
const RESTING_CARD_TTL = 86400000;
// The space benni-routines runs its routines in: last in the list, folded once when it appears,
// a clock instead of an avatar, and kept out of "En cours" and "Au repos" (a blocked routine still needs you).
const routinesSpaceId = () => shared("benni.routines")?.spaceId ?? null;
const isRoutineSession = (a) => Boolean(a.space) && a.space === routinesSpaceId();
// gh (and git pushing through gh's credentials) answers as the folder's account only through its mise env (GH_TOKEN).
const WITH_FOLDER_ENV = 'command -v mise >/dev/null 2>&1 && exec mise exec -- "$@"; exec "$@"';

async function runWithFolderEnv(argv, cwd, on, timeout = 60000) {
  const r = await exec("sh", ["-c", WITH_FOLDER_ENV, "sh", ...argv], { cwd, on, timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `${argv[0]} a échoué`);
  return r.stdout;
}

async function runGit(args, cwd, on) {
  const r = await exec("git", args, { cwd, on, timeout: 60000 });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim().split("\n").pop() };
}

// A carded session's pull request, from the issue branch to the merge: shown on its card, with
// the next step as a button (open the PR, hand the failing CI to the agent, clean up once merged).
const PR_TTL = 30000;
const PR_TTL_IN_BACKGROUND = 120000;
const PR_FIELDS = "number,title,url,state,isDraft,headRefOid,statusCheckRollup";
const TRUNK_BRANCHES = new Set(["main", "master", "(detached)"]);
// On these, work goes straight to the remote: commit and push instead of a PR.
const PUSHED_DIRECTLY_BRANCHES = new Set(["main", "master"]);
// A step's state lives with the PR on a branch of its own, else with the session's folder.
const stepKey = (session) => session.prKey ?? session.key;
const FAILED_CHECK_VERDICTS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING_CHECK_VERDICTS = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
const CI_LOG_LINES_PER_RUN = 80;
const CLEAN_CONFIRM_MS = 4000;
// hc send pauses about a second before pasting; longer means it holds for a draft typed in the session.
const DRAFT_HOLD_HINT_MS = 2000;
const SPACE_CLOSE_WAIT = 10000;
const ICONS = "mods/gh-issues/icons";

function failedChecksOf(pr) {
  return (pr?.statusCheckRollup ?? []).flatMap((check) => {
    const isStatusContext = check.__typename === "StatusContext";
    const verdict = isStatusContext ? check.state : check.status === "COMPLETED" ? check.conclusion : check.status;
    if (!FAILED_CHECK_VERDICTS.has(verdict)) return [];
    return [{ name: isStatusContext ? check.context : check.workflowName ? `${check.workflowName} · ${check.name}` : check.name, url: isStatusContext ? check.targetUrl : check.detailsUrl }];
  });
}

function checksOutcome(pr) {
  const checks = pr?.statusCheckRollup ?? [];
  if (!checks.length) return "none";
  if (failedChecksOf(pr).length) return "failure";
  const isPending = (check) => {
    const verdict = check.__typename === "StatusContext" ? check.state : check.status === "COMPLETED" ? check.conclusion : check.status;
    return !verdict || PENDING_CHECK_VERDICTS.has(verdict);
  };
  return checks.some(isPending) ? "pending" : "success";
}

function pullRequestLook(pr, t) {
  if (pr.state === "MERGED") return { icon: `${ICONS}/pr-merged.svg`, color: t.ansi5, label: "fusionnée" };
  if (pr.state === "CLOSED") return { icon: `${ICONS}/pr-closed.svg`, color: t.ansi1, label: "fermée" };
  if (pr.isDraft) return { icon: `${ICONS}/pr-draft.svg`, color: t.dim, label: "brouillon" };
  return { icon: `${ICONS}/pr-open.svg`, color: t.ansi2, label: "ouverte" };
}

const CHECKS_LOOK = {
  success: { glyph: "✓", label: "CI ok", tone: "ansi2" },
  failure: { glyph: "✗", label: "CI en échec", tone: "ansi1" },
  pending: { glyph: "●", label: "CI en cours", tone: "working" },
};

// "build\tRun tests\t2026-11-25T10:00:00.1234567Z error: ..." -> "error: ..."
const ciLogText = (line) => line.split("\t").slice(2).join("\t").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\x1b\[[0-9;]*m/g, "");
const actionsRunIds = (checks) => [...new Set(checks.map((c) => /\/actions\/runs\/(\d+)/.exec(c.url ?? "")?.[1]).filter(Boolean))];
const isInside = (folder, root) => Boolean(folder) && (folder === root || folder.startsWith(`${root}/`));
// The app's own opener on macOS and Windows; under Linux it may run inside WSL, where
// xdg-open has nothing to hand the URL to, so Windows' browser gets it instead.
const OPEN_ON_LINUX = 'if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then command -v wslview >/dev/null 2>&1 && exec wslview "$1"; exec explorer.exe "$1"; fi; exec xdg-open "$1"';
const openUrl = (url, cx) => {
  if (!url) return;
  if (window()?.platform === "linux") exec("sh", ["-c", OPEN_ON_LINUX, "sh", url]);
  else cx.open_url(url);
};
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

const sessionTitle = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function sessionName(a, tab) {
  const live = sessionTitle(a.title);
  const looksLikePath = /^[~/]|^[A-Za-z]:\\/.test((a.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const meaningful = live && live !== a.address && live !== a.program?.name && !looksLikePath && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  if (meaningful) return live;
  if (tab?.named && !/^\d+$/.test(tab.name)) return tab.name;
  return a.program?.name || a.app || "Agent";
}

function terminalName(p) {
  const live = sessionTitle(p.title);
  const looksLikePath = /^[~/]|^[A-Za-z]:\\/.test(live) || (live.includes("/") && !/\s/.test(live));
  const meaningful = live && live !== p.program?.name && !looksLikePath && !live.includes("@") && live.toLowerCase() !== p.program?.key;
  if (meaningful) return live;
  return (p.program?.shell && folderName(p.cwd)) || p.program?.name || "Terminal";
}

function folderName(cwd) {
  if (!cwd) return "";
  const home = cwd.match(/^\/(Users|home)\/[^/]+\/?$/);
  return home ? "~" : base(cwd);
}

function elapsed(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's own report when it gives one (its shape isn't documented: text, or an object holding it).
function reportText(report) {
  if (!report) return "";
  if (typeof report === "string") return report;
  return report.message ?? report.detail ?? report.text ?? report.summary ?? "";
}

function blockedReason(a, report) {
  return sessionTitle(reportText(report)) || a.sessionName;
}

// A Claude session started in a folder holding bot.json shows a bot instead of Claude's mark.
const BOT_MARKER = "bot.json";
const BOT_ICON = "mods/benni-spaces/bot.svg";
const isClaude = (a) => a.program?.key === "claude" || a.app === "claude-code";

function agentIcon(program, size, color, bot = false) {
  if (bot) return svg(BOT_ICON).size(size).flex_none().text_color(color);
  if (!program?.icon) return null;
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(color) : image(program.icon).w(size).h(size).flex_none();
}

// Workspaces group the spaces (work, personal…). benni-settings owns the list and the switch;
// this list reads them and records where a dropped space goes. Mods can't share modules, so
// this reader repeats benni-settings' own: same key, same rules.
const WORKSPACES_KEY = "benni.workspaces";
const DEFAULT_WORKSPACE = { id: "default", name: "Default" };
// A space made from a workspace's "+" joins it if it shows up within this long.
const NEW_SPACE_WAIT = 10000;

function readWorkspaces() {
  const stored = shared(WORKSPACES_KEY) ?? {};
  const list = Array.isArray(stored.list) ? stored.list.filter((w) => w?.id && typeof w.name === "string") : [];
  if (!list.some((w) => w.id === DEFAULT_WORKSPACE.id)) list.unshift({ ...DEFAULT_WORKSPACE });
  const of = stored.of && typeof stored.of === "object" && !Array.isArray(stored.of) ? stored.of : {};
  return { enabled: stored.enabled === true, list, of };
}

function workspaceOfSpace(store, spaceId) {
  const id = store.of[spaceId];
  return store.list.some((w) => w.id === id) ? id : DEFAULT_WORKSPACE.id;
}

const workspaceDropKey = (workspaceId) => `ws:${workspaceId}`;
const openSettings = () => openOverlay({ mod: "benni-settings", kind: "dialog", width: 680, height: 460 });

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    this.bots = {}; // where() of a Claude session -> its folder holds bot.json
    this.botChecked = {}; // where() -> when bot.json was last looked for
    this.issues = {}; // where() + "#" + number -> { title, url }, or null when gh couldn't say
    this.sessionGit = {}; // [machine, folder] of a working session -> { name, branch, linked, at }
    this.pullRequests = {}; // pullRequestKey() -> { pr: the branch's PR or null, at, loading }
    this.lifecycle = {}; // pullRequestKey() -> { busy: the running step's label, error, sentForHead, confirmCleanUntil }
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    try { this.foldedSpaces = new Set(JSON.parse(localStorage.getItem("spaces.folded") ?? "[]")); } catch { this.foldedSpaces = new Set(); }
    this.selectedWorkspace = localStorage.getItem("workspaces.selected") ?? DEFAULT_WORKSPACE.id; // the tab whose spaces the list shows
    this.followedActiveSpace = null; // the active space the selected tab last followed
    this.newSpaceWorkspace = null; // { id, at, known }: the workspace a space being made from the sidebar joins
    this.lastRows = []; // the rows last drawn, with their workspace: a dropped space takes its worktrees along
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    cx.timer.every(30000, cx => cx.notify());
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    if (!checking()) {
      cx.timer.after(UPDATE_FIRST_CHECK_DELAY, (cx) => this.checkLayoutUpdate(cx));
      cx.timer.every(UPDATE_CHECK_INTERVAL, (cx) => this.checkLayoutUpdate(cx));
    }
  }

  // Notifies once per new commit on GitHub; a layout installed by hand (no recorded commit) is never nagged.
  checkLayoutUpdate(cx) {
    cx.spawn(async () => {
      try {
        const [installed, latest] = await Promise.all([readInstalledCommit(), readLatestCommit(chosenBranch())]);
        setShared(UPDATE_KEY, { installed, latest });
        if (!installed || installed === latest || localStorage.getItem("update.notified") === latest) return;
        localStorage.setItem("update.notified", latest);
        notify({
          title: "Nouvelle version du layout",
          body: "Clique pour l'installer depuis les Réglages.",
          level: "info",
          timeout: UPDATE_NOTICE_DURATION,
          action: { name: "mod.open", args: { name: "benni-settings" } },
        });
      } catch { /* offline: try again at the next tick */ }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    this.placeNewSpace(now, sp);
    const ps = panes();
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    this.lookForBots(now, sp, ps, cx);
    this.lookAtCardedSessions(now, sp, ps, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // Where each Claude session runs: [machine, folder], as where() spells it.
  claudePlaces(sp, ps) {
    const machineOf = new Map(sp.map((s) => [s.id, s.machine ?? null]));
    const cwdOf = new Map(ps.map((p) => [p.pane, p.cwd]));
    const places = new Map();
    for (const a of agents()) {
      const cwd = cwdOf.get(a.pane);
      if (isClaude(a) && cwd) places.set(a.address, JSON.stringify([machineOf.get(a.space) ?? null, cwd]));
    }
    return places;
  }

  lookForBots(now, sp, ps, cx) {
    this.botPlaces = this.claudePlaces(sp, ps);
    for (const key of new Set(this.botPlaces.values())) {
      if (now - (this.botChecked[key] ?? 0) < FALLBACK) continue;
      this.botChecked[key] = now;
      const [on, cwd] = JSON.parse(key);
      cx.spawn(async (cx) => {
        try {
          const r = await exec("test", ["-f", BOT_MARKER], { cwd, on });
          const bot = r.code === 0;
          if (this.bots[key] === bot) return;
          this.bots[key] = bot;
          cx.notify();
        } catch {} // unreachable machine: asked again after FALLBACK
      });
    }
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  foldRoutinesSpaceOnce() {
    const id = routinesSpaceId();
    if (!id || localStorage.getItem("routines.folded") === id || !spaces().some((s) => s.id === id)) return;
    localStorage.setItem("routines.folded", id);
    this.foldedSpaces.add(id);
    this.saveFoldedSpaces();
  }

  saveFoldedSpaces() {
    const ids = new Set(spaces().map((s) => s.id));
    for (const id of this.foldedSpaces) if (!ids.has(id)) this.foldedSpaces.delete(id);
    localStorage.setItem("spaces.folded", JSON.stringify([...this.foldedSpaces]));
  }

  // A space and the worktrees drawn under it move to `workspaceId` together.
  moveToWorkspace(spaceId, workspaceId) {
    const store = readWorkspaces();
    const at = this.lastRows.findIndex((r) => r.w.id === spaceId);
    const ids = [spaceId];
    if (at >= 0 && !this.lastRows[at].tree) for (const r of this.lastRows.slice(at + 1)) {
      if (!r.tree) break;
      ids.push(r.w.id);
    }
    if (ids.every((id) => workspaceOfSpace(store, id) === workspaceId)) return;
    for (const id of ids) {
      if (workspaceId === DEFAULT_WORKSPACE.id) delete store.of[id];
      else store.of[id] = workspaceId;
    }
    setShared(WORKSPACES_KEY, store);
  }

  newSpaceIn(workspaceId) {
    this.newSpaceWorkspace = { id: workspaceId, at: Date.now(), known: new Set(spaces().map((s) => s.id)) };
    run("space.new");
  }

  placeNewSpace(now, sp) {
    const pending = this.newSpaceWorkspace;
    if (!pending) return;
    if (now - pending.at > NEW_SPACE_WAIT) { this.newSpaceWorkspace = null; return; }
    const made = sp.find((s) => !pending.known.has(s.id));
    if (!made) return;
    this.newSpaceWorkspace = null;
    this.moveToWorkspace(made.id, pending.id);
  }

  selectWorkspace(id, cx) {
    this.selectedWorkspace = id;
    localStorage.setItem("workspaces.selected", id);
    cx?.notify();
  }

  // The selected tab follows the active space when another one becomes active, from anywhere.
  shownWorkspace(store, rows) {
    const active = rows.find((r) => r.w.active);
    if (active && active.w.id !== this.followedActiveSpace) {
      this.followedActiveSpace = active.w.id;
      if (active.ws !== this.selectedWorkspace) this.selectWorkspace(active.ws);
    }
    if (!store.list.some((w) => w.id === this.selectedWorkspace)) this.selectedWorkspace = DEFAULT_WORKSPACE.id;
    return this.selectedWorkspace;
  }

  // A workspace tab or its empty slot takes a dragged space.
  workspaceDropTarget(el, ws) {
    const key = workspaceDropKey(ws.id);
    return el
      .on_mouse_move((_e, cx) => {
        if (this.pressed !== null && this.over !== key) { this.over = key; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        this.over = null;
        if (from !== null) this.moveToWorkspace(from, ws.id);
        cx.notify();
      });
  }

  workspaceTab(ws, rows, selected, t, collapsed) {
    const dropping = this.pressed !== null && this.over === workspaceDropKey(ws.id);
    const holdsActiveSpace = rows.some((r) => r.w.active);
    const tab = h_flex().id(`workspace-${ws.id}`).flex_none().items_center().rounded(6).cursor_pointer()
      .when(dropping, (el) => el.bg(t.accent + "26"))
      .when(!dropping && selected, (el) => el.bg(t.selected))
      .when(!dropping && !selected, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.selectWorkspace(ws.id, cx))
      .on_mouse_down("right", openSettings)
      .tooltip(`${ws.name} · ${rows.length} space${rows.length > 1 ? "s" : ""}`);
    if (collapsed) {
      return railCell(this.workspaceDropTarget(tab, ws).w(RAIL_CELL).h(22).justify_center()
        .text_size(10).font_bold().text_color(selected ? t.foreground : t.dim).child([...ws.name].slice(0, 2).join("").toUpperCase()));
    }
    return this.workspaceDropTarget(tab, ws).h(24).px(8).gap(5)
      .text_size(11.5).font_semibold().text_color(selected ? t.foreground : t.muted)
      .child(ws.name)
      .child(div().text_size(10.5).text_color(t.dim).child(String(rows.length)))
      .when(holdsActiveSpace && !selected, (el) => el.child(div().size(5).rounded_full().flex_none().bg(t.accent)));
  }

  workspaceTabs(t, collapsed) {
    const store = readWorkspaces();
    const shown = this.shownWorkspace(store, this.lastRows);
    const tabs = store.list.map((ws) => this.workspaceTab(ws, this.lastRows.filter((r) => r.ws === ws.id), ws.id === shown, t, collapsed));
    if (collapsed) return v_flex().flex_none().gap(2).pb(6).children(tabs);
    return h_flex().id("workspace-tabs").flex_none().h(32).px(8).gap(2).items_center().overflow_x_scroll().children(tabs);
  }

  emptyWorkspace(ws, t, collapsed) {
    if (collapsed) return div().h(2).flex_none();
    const dropping = this.pressed !== null && this.over === workspaceDropKey(ws.id);
    return this.workspaceDropTarget(h_flex().id(`workspace-empty-${ws.id}`).h(28).mx(4).flex_none().items_center().justify_center()
      .rounded(7).border_1().border_color(dropping ? t.accent : t.border).text_size(11.5).text_color(t.dim), ws)
      .child(this.pressed !== null ? "Déposer ici" : "Glisse un space ici");
  }

  toggleSpaceFold(id, cx) {
    this.foldedSpaces.has(id) ? this.foldedSpaces.delete(id) : this.foldedSpaces.add(id);
    this.saveFoldedSpaces();
    cx.notify();
  }

  allSpacesFolded() {
    const sp = spaces();
    return sp.length > 0 && sp.every((s) => this.foldedSpaces.has(s.id));
  }

  toggleAllSpacesFold(cx) {
    this.foldedSpaces = this.allSpacesFolded() ? new Set() : new Set(spaces().map((s) => s.id));
    this.saveFoldedSpaces();
    cx.notify();
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  trackAgentStates(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  agentStatus(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(status === "done" ? (t.done ?? t.dim) : t.dim + "00");
  }

  agentRow(a, tree, t) {
    const pic = agentIcon(a.program, SESSION_ICON, t.foreground, this.bots[this.botPlaces?.get(a.address)] === true);
    const since = this.changed[a.address]?.at;
    const quiet = a.status === "idle" && !a.focused;
    return h_flex()
      .id(`space-agent-${a.address}`)
      .pl(sessionIndent(tree))
      .pr(8)
      .h(26)
      .flex_none()
      .gap(SESSION_GAP)
      .items_center()
      .rounded(8)
      .text_size(12.5)
      .cursor_pointer()
      .when(a.focused, (el) => el.bg(t.selected))
      .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(a.sessionName))
      .when(Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(elapsed(Date.now() - since))))
      .child(this.agentStatus(t, a.status));
  }

  // Where a session runs: its pane's folder and branch, the git read there, its ticket.
  sessionPlace(a, sp, ps) {
    const pane = ps.find((p) => p.pane === a.pane);
    const machine = sp.find((s) => s.id === a.space)?.machine ?? null;
    const cwd = pane?.cwd ?? null;
    const key = cwd ? JSON.stringify([machine, cwd]) : null;
    const g = key ? this.sessionGit[key] ?? this.git[key] ?? null : null;
    const branch = g?.branch ?? pane?.branch ?? null;
    const issue = issueNumber(branch, a.tab_name, sessionName(a));
    return { machine, cwd, key, g, branch, issue, issueKey: key && issue ? `${key}#${issue}` : null, prKey: this.pullRequestKey(machine, key) };
  }

  // A carded session's own folder (often a worktree its space doesn't point at): its git, then its ticket.
  lookAtCardedSessions(now, sp, ps, cx) {
    const carded = agents().filter((a) => a.status === "blocked" || ((CARDED_STATUSES.includes(a.status) || this.restedRecently(a, now)) && !isRoutineSession(a)));
    const keys = new Set();
    const prKeys = new Set();
    for (const a of carded) {
      const { machine, cwd, key, issue, issueKey } = this.sessionPlace(a, sp, ps);
      if (!key) continue;
      keys.add(key);
      // Also as soon as the agent changed status: a turn that ends may have committed or pushed.
      const lastLook = this.sessionGit[key]?.at ?? 0;
      if (now - lastLook > SESSION_GIT_TTL || (this.changed[a.address]?.at ?? 0) > lastLook) {
        this.sessionGit[key] = { ...this.sessionGit[key], at: now };
        cx.spawn(async (cx) => {
          const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--abbrev-ref", "HEAD"], { cwd, on: machine });
          if (r.code !== 0) return;
          const [top, common, branch] = r.stdout.trim().split("\n");
          const name = common.endsWith("/.git") ? base(common.slice(0, -5)) : base(common).replace(/\.git$/, "");
          const main = common.endsWith("/.git") ? common.slice(0, -5) : top;
          const unmerged = await exec("git", ["rev-list", "--count", "origin/HEAD..HEAD"], { cwd, on: machine });
          const commitsAhead = unmerged.code === 0 ? Number(unmerged.stdout.trim()) : 0;
          const local = PUSHED_DIRECTLY_BRANCHES.has(branch) ? await this.readLocalWork(cwd, machine) : { uncommitted: 0, unpushed: 0 };
          this.sessionGit[key] = { name, main, top, branch: branch === "HEAD" ? "(detached)" : branch, linked: common !== `${top}/.git`, commitsAhead, ...local, at: Date.now() };
          cx.notify();
        });
      }
      const prKey = this.pullRequestKey(machine, key);
      if (prKey) {
        prKeys.add(prKey);
        this.lookAtPullRequest(prKey, a, now, cx);
      }
      // From the main checkout: a worktree elsewhere (~/.orca, ~/.herdr) misses the folder's mise env, so gh would ask as another account.
      const main = this.sessionGit[key]?.main;
      if (!issueKey || !main || issueKey in this.issues) continue;
      this.issues[issueKey] = null;
      cx.spawn(async (cx) => {
        const r = await exec("sh", ["-c", WITH_FOLDER_ENV, "sh", "gh", "api", `repos/{owner}/{repo}/issues/${issue}`, "--jq", "{title, url: .html_url}"], { cwd: main, on: machine, timeout: 30000 });
        try { if (r.code === 0) this.issues[issueKey] = JSON.parse(r.stdout); } catch {}
        cx.notify();
      });
    }
    for (const k of Object.keys(this.sessionGit)) if (!keys.has(k)) delete this.sessionGit[k];
    for (const k of Object.keys(this.pullRequests)) if (!prKeys.has(k)) delete this.pullRequests[k];
  }

  // [machine, main checkout, branch] of a session on a branch of its own, once its git is read.
  pullRequestKey(machine, sessionKey) {
    const sg = sessionKey ? this.sessionGit[sessionKey] : null;
    if (!sg?.main || !sg.branch || TRUNK_BRANCHES.has(sg.branch)) return null;
    return JSON.stringify([machine, sg.main, sg.branch]);
  }

  lookAtPullRequest(prKey, a, now, cx) {
    const known = this.pullRequests[prKey];
    const ttl = window().active ? PR_TTL : PR_TTL_IN_BACKGROUND;
    if (known?.loading || now - (known?.at ?? 0) < ttl) return;
    this.pullRequests[prKey] = { ...known, loading: true };
    cx.spawn(async (cx) => this.readPullRequest(prKey, a, cx));
  }

  async readPullRequest(prKey, a, cx) {
    const [machine, main, branch] = JSON.parse(prKey);
    const before = this.pullRequests[prKey];
    try {
      const json = await runWithFolderEnv(["gh", "pr", "list", "--state", "all", "--head", branch, "--limit", "1", "--json", PR_FIELDS], main, machine, 30000);
      const pr = JSON.parse(json)[0] ?? null;
      this.pullRequests[prKey] = { ...before, pr, answered: true, at: Date.now(), loading: false };
      if (before?.at && a) this.announcePullRequestChange(before.pr, pr, a);
    } catch {
      this.pullRequests[prKey] = { ...before, at: Date.now(), loading: false };
    }
    cx.notify();
  }

  // Only a change seen while running: a CI that just failed, a PR that just merged.
  announcePullRequestChange(was, pr, a) {
    if (!pr) return;
    const focus = { name: "pane.focus", args: { pane: a.pane } };
    if (pr.state === "MERGED" && was?.state !== "MERGED") {
      notify({ title: `PR #${pr.number} fusionnée`, body: `${pr.title}\n« Nettoyer » sur la carte de ${a.space_name} retire son worktree et sa branche.`, level: "success", action: focus });
    } else if (pr.state === "OPEN" && checksOutcome(pr) === "failure" && checksOutcome(was) !== "failure") {
      notify({ title: `CI en échec sur #${pr.number}`, body: `${pr.title}\n« Corriger la CI » sur la carte l'envoie à l'agent.`, level: "error", action: focus });
    }
  }

  setLifecycle(prKey, change, cx) {
    this.lifecycle[prKey] = { ...this.lifecycle[prKey], ...change };
    cx.notify();
  }

  runLifecycleStep(prKey, busyLabel, step, cx) {
    if (this.lifecycle[prKey]?.busy) return;
    this.setLifecycle(prKey, { busy: busyLabel, error: null }, cx);
    cx.spawn(async (cx) => {
      try { await step(cx); }
      catch (error) { this.setLifecycle(prKey, { error: String(error?.message ?? error) }, cx); }
      finally { this.setLifecycle(prKey, { busy: null }, cx); }
    });
  }

  // Files changed and commits not on the upstream, for a session on main or master.
  async readLocalWork(cwd, machine) {
    const [status, upstream] = await both(
      exec("git", ["--no-optional-locks", "status", "--porcelain"], { cwd, on: machine }),
      exec("git", ["rev-list", "--count", "@{upstream}..HEAD"], { cwd, on: machine }),
    );
    return {
      uncommitted: status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0,
      unpushed: upstream.code === 0 ? Number(upstream.stdout.trim()) : 0,
    };
  }

  // Types the message into the agent's prompt; the card says so when hc send waits for the person's draft.
  async sendToAgent(key, a, message, cx) {
    let delivered = false;
    cx.timer.after(DRAFT_HOLD_HINT_MS, (cx) => {
      if (!delivered) this.setLifecycle(key, { busy: "En attente de ton brouillon…" }, cx);
    });
    try {
      const r = await hc(["send", a.address, message]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "envoi à l'agent impossible");
    } finally {
      delivered = true;
    }
  }

  // The agent knows what it changed, so it writes the commit message; the card waits for its next git read.
  askCommitAndPush(a, session, branch, cx) {
    this.runLifecycleStep(stepKey(session), "Envoi…", async (cx) => {
      const message = `Commite tous les changements en cours (des commits cohérents, avec des messages clairs), puis pousse sur ${branch}.`;
      await this.sendToAgent(stepKey(session), a, message, cx);
      this.setLifecycle(stepKey(session), { commitAskedAt: Date.now() }, cx);
    }, cx);
  }

  pushTrunk(session, cx) {
    this.runLifecycleStep(stepKey(session), "Push…", async (cx) => {
      await runWithFolderEnv(["git", "push"], session.cwd, session.machine);
      this.sessionGit[session.key] = { ...this.sessionGit[session.key], unpushed: 0, at: 0 };
      cx.notify();
    }, cx);
  }

  // Pushes the branch and opens its PR: the ticket's title (else the last commit's), "Closes #N", the commits.
  openPullRequest(prKey, session, ticket, cx) {
    const [machine, main, branch] = JSON.parse(prKey);
    this.runLifecycleStep(prKey, "Ouverture…", async (cx) => {
      await runWithFolderEnv(["git", "push", "-u", "origin", branch], main, machine);
      const lastSubject = (await runGit(["log", "-1", "--format=%s", branch], main, machine)).out;
      const commits = (await runGit(["log", "--reverse", "--format=- %s", `origin/HEAD..${branch}`], main, machine)).out;
      const title = ticket?.title || lastSubject || branch;
      const body = [session.issue ? `Closes #${session.issue}` : null, commits].filter(Boolean).join("\n\n");
      await runWithFolderEnv(["gh", "pr", "create", "--head", branch, "--title", title, "--body", body], main, machine);
      await this.readPullRequest(prKey, null, cx);
    }, cx);
  }

  // Hands the failing jobs' logs to the agent, as if typed in its prompt.
  sendFailingCi(prKey, a, pr, cx) {
    const [machine, main] = JSON.parse(prKey);
    this.runLifecycleStep(prKey, "Lecture des logs…", async (cx) => {
      const failed = failedChecksOf(pr);
      const logs = [];
      for (const runId of actionsRunIds(failed)) {
        const out = await runWithFolderEnv(["gh", "run", "view", runId, "--log-failed"], main, machine).catch(() => "");
        const lines = out.split("\n").map(ciLogText).filter((l) => l.trim());
        if (lines.length) logs.push(lines.slice(-CI_LOG_LINES_PER_RUN).join("\n"));
      }
      const checkList = failed.map((c) => `- ${c.name}${c.url ? ` : ${c.url}` : ""}`).join("\n");
      const message = [
        `La CI de la PR #${pr.number} échoue. Trouve la cause, corrige, commite et pousse sur cette branche.`,
        `Checks en échec :\n${checkList}`,
        logs.length ? `Fin des logs des jobs en échec :\n\`\`\`\n${logs.join("\n\n")}\n\`\`\`` : null,
      ].filter(Boolean).join("\n\n");
      await this.sendToAgent(prKey, a, message, cx);
      this.setLifecycle(prKey, { sentForHead: pr.headRefOid }, cx);
    }, cx);
  }

  // Once merged: closes the spaces on the worktree, removes it, then deletes the local branch.
  // Refuses a worktree with uncommitted changes; keeps a branch holding commits the PR didn't merge.
  cleanUpMerged(prKey, session, pr, cx) {
    const [machine, main, branch] = JSON.parse(prKey);
    const top = this.sessionGit[session.key]?.top;
    if (!top || top === main) return;
    this.runLifecycleStep(prKey, "Nettoyage…", async (cx) => {
      const status = await runGit(["--no-optional-locks", "status", "--porcelain"], top, machine);
      if (!status.ok) throw new Error(status.err || "git status a échoué");
      if (status.out) throw new Error("modifications non commitées dans le worktree : nettoyage annulé");
      const ps = panes();
      const closing = spaces().filter((s) => (s.machine ?? null) === machine && (isInside(s.folder, top) || isInside(place(s, ps), top)));
      const closingTerminals = new Set(closing.flatMap((s) => {
        const tabs = new Set((s.tabs ?? []).map((tab) => tab.id));
        return ps.filter((p) => p.terminal && tabs.has(p.tab)).map((p) => p.terminal);
      }));
      for (const s of closing) run("space.close", { id: s.id, confirmed: true });
      // The card goes with the space: from here on, failures can only be told in a notification.
      try {
        const deadline = Date.now() + SPACE_CLOSE_WAIT;
        while (terminals().some((k) => k.state === "live" && closingTerminals.has(k.address))) {
          if (Date.now() >= deadline) throw new Error("les terminaux du space ne se sont pas arrêtés");
          await cx.sleep(50);
        }
        const removed = await runGit(["worktree", "remove", top], main, machine);
        if (!removed.ok) throw new Error(removed.err || "git worktree remove a échoué");
        const head = (await runGit(["rev-parse", `refs/heads/${branch}`], main, machine)).out;
        const deleted = await runGit(["branch", head === pr.headRefOid ? "-D" : "-d", branch], main, machine);
        notify(deleted.ok
          ? { title: `#${pr.number} nettoyée`, body: `Worktree et branche ${branch} supprimés.`, level: "success" }
          : { title: `#${pr.number} : worktree supprimé, branche gardée`, body: `${branch} a des commits absents de la PR (${deleted.err}).`, level: "warning" });
      } catch (error) {
        notify({ title: `#${pr.number} : nettoyage interrompu`, body: String(error?.message ?? error), level: "error" });
      }
      delete this.pullRequests[prKey];
    }, cx);
  }

  restedRecently(a, now) {
    return RESTING_STATUSES.includes(a.status) && now - (this.changed[a.address]?.at ?? 0) < RESTING_CARD_TTL;
  }

  agentsWithStatus(...statuses) {
    const tabs = new Map(spaces().flatMap((s) => s.tabs ?? []).map((tab) => [tab.id, tab]));
    const reports = new Map(terminals().map((k) => [k.address, k.report]));
    const since = (a) => this.changed[a.address]?.at ?? 0;
    return agents()
      .filter((a) => statuses.includes(a.status))
      .map((a) => ({ ...a, sessionName: sessionName(a, tabs.get(a.tab)), report: reports.get(a.address) }))
      .sort((x, y) => since(y) - since(x));
  }

  spaceMark(spaceId, name, size) {
    if (spaceId === routinesSpaceId()) return routinesMark(size, theme());
    const color = (shared("space.colors") ?? {})[spaceId] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? theme()[color]);
    return h_flex().size(size).flex_none().rounded(4).bg(fill).items_center().justify_center()
      .text_size(size * 0.6).font_bold().text_color("#ffffff").child([...(name ?? "")][0]?.toUpperCase() ?? "?");
  }

  // A session above the spaces, tinted by its status: what it is, why it waits (blocked), its ticket, where it runs.
  sessionCard(a, place, t) {
    const since = this.changed[a.address]?.at;
    const tint = tone(t, a.status);
    const { g, branch, issue, issueKey } = place;
    const ticket = issueKey ? this.issues[issueKey] : null;
    const repo = g?.name ?? (place.cwd ? base(place.cwd) : null);
    const shownBranch = branch && branch !== "main" && branch !== "master" ? branch : null;
    const detailIndent = 16 + SESSION_GAP;
    const reason = a.status === "blocked" ? blockedReason(a, a.report) : null;
    const pr = place.prKey ? this.pullRequests[place.prKey]?.pr ?? null : null;
    const lifecycle = place.key ? this.lifecycle[stepKey(place)] : null;
    const nextStep = this.nextStepButton(a, place, pr, ticket, t, detailIndent);
    return v_flex()
      .id(`card-${a.address}`)
      .flex_none()
      .px(9)
      .py(7)
      .gap(4)
      .rounded(8)
      .border_1()
      .border_color(tint + (a.focused ? "66" : "33"))
      .bg(tint + (a.focused ? "22" : "0d"))
      .cursor_pointer()
      .hover((s) => s.bg(tint + "1c"))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(h_flex().gap(SESSION_GAP).items_center()
        .child(this.spaceMark(a.space, a.space_name, 16))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(a.sessionName))
        .when(Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(elapsed(Date.now() - since))))
        .child(this.agentStatus(t, a.status)))
      .when(Boolean(reason) && reason !== a.sessionName, (el) => el.child(div().pl(detailIndent).truncate().text_size(11.5).text_color(tint).child(reason)))
      .when(Boolean(issue), (el) => el.child(h_flex().id(`card-issue-${a.address}`).pl(detailIndent).gap(5).items_center().text_size(11.5)
        .when(Boolean(ticket?.url), (row) => row.tooltip("Ouvrir le ticket sur GitHub")
          .on_click((_e, cx) => { cx.stop_propagation(); openUrl(ticket.url, cx); }))
        .child(svg("mods/gh-issues/icons/issue.svg").size(12).flex_none().text_color(t.ansi2))
        .child(div().flex_none().font_semibold().text_color(t.ansi2).child(`#${issue}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(ticket?.title ?? ""))))
      .when(Boolean(pr), (el) => el.child(this.pullRequestLine(a, pr, t, detailIndent)))
      .when(Boolean(nextStep), (el) => el.child(nextStep))
      .when(Boolean(lifecycle?.error), (el) => el.child(div().pl(detailIndent).text_size(11).text_color(t.ansi1).child(lifecycle.error)))
      .child(h_flex().pl(detailIndent).gap(5).items_center().text_size(11).text_color(t.dim)
        .child(svg(`mods/workspace-chrome/${g || branch ? "git-branch" : "folder"}.svg`).size(12).flex_none())
        .child(div().flex_initial().min_w(0).truncate().child([a.space_name !== repo ? a.space_name : null, repo].filter(Boolean).join(" · ") || "?"))
        .when(Boolean(shownBranch) && shownBranch !== a.space_name, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(shownBranch)))
        .when(!shownBranch || shownBranch === a.space_name, (el) => el.child(div().flex_1()))
        .when(Boolean(g?.linked), (el) => el.child(div().flex_none().px(4).h(14).rounded(3).border_1().border_color(t.dim + "66").text_size(10).text_color(t.muted).flex().items_center().child("worktree"))));
  }

  // "#12 ✗ ouverte · CI en échec": a click opens the PR.
  pullRequestLine(a, pr, t, detailIndent) {
    const look = pullRequestLook(pr, t);
    const checks = pr.state === "OPEN" ? CHECKS_LOOK[checksOutcome(pr)] : null;
    return h_flex().id(`card-pr-${a.address}`).pl(detailIndent).gap(5).items_center().text_size(11.5)
      .tooltip("Ouvrir la PR sur GitHub")
      .on_click((_e, cx) => { cx.stop_propagation(); openUrl(pr.url, cx); })
      .child(svg(look.icon).size(12).flex_none().text_color(look.color))
      .child(div().flex_none().font_semibold().text_color(look.color).child(`#${pr.number}`))
      .when(Boolean(checks), (el) => el.child(checks === CHECKS_LOOK.pending
        ? div().flex_none().text_color(t.working).frames(["◐", "◓", "◑", "◒"], 160)
        : div().flex_none().text_color(t[checks.tone]).child(checks.glyph)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child([look.label, checks?.label].filter(Boolean).join(" · ")));
  }

  // What comes next for a session at rest: open its PR, hand it the failing CI, or clean up once merged.
  nextStepButton(a, session, pr, ticket, t, detailIndent) {
    if (!RESTING_STATUSES.includes(a.status)) return null;
    const { prKey } = session;
    const lifecycle = this.lifecycle[stepKey(session)] ?? {};
    const button = (id, label, tint, tooltip, onPress) => h_flex().pl(detailIndent).child(
      div().id(`card-step-${id}-${a.address}`).h(20).px(8).flex().flex_none().items_center().rounded(5)
        .text_size(11).font_medium().border_1().border_color(tint + "55").bg(tint + "1a").text_color(tint)
        .when(!lifecycle.busy, (el) => el.cursor_pointer().hover((s) => s.bg(tint + "33")))
        .tooltip(tooltip)
        .on_click((_e, cx) => { cx.stop_propagation(); if (!lifecycle.busy) onPress(cx); })
        .child(lifecycle.busy ?? label));
    const sg = this.sessionGit[session.key];
    if (sg && PUSHED_DIRECTLY_BRANCHES.has(sg.branch)) {
      if (sg.uncommitted > 0) {
        if ((lifecycle.commitAskedAt ?? 0) > sg.at) return h_flex().pl(detailIndent).text_size(11).text_color(t.dim).child("Commit et push demandés à l'agent");
        return button("commit-push", `Commit & push (${sg.uncommitted})`, t.accent,
          `Demande à l'agent de commiter ses ${sg.uncommitted} fichier${sg.uncommitted > 1 ? "s" : ""} modifié${sg.uncommitted > 1 ? "s" : ""} puis de pousser sur ${sg.branch}`,
          (cx) => this.askCommitAndPush(a, session, sg.branch, cx));
      }
      if (sg.unpushed > 0) {
        return button("push", `Push ↑${sg.unpushed}`, t.accent, `git push de ${sg.branch} vers son upstream`,
          (cx) => this.pushTrunk(session, cx));
      }
      return null;
    }
    const known = prKey ? this.pullRequests[prKey] : null;
    if (!known?.answered) return null;
    if (!pr && sg?.commitsAhead > 0) {
      return button("open-pr", "Ouvrir la PR", t.accent, `Pousse ${sg.branch} et ouvre sa PR${session.issue ? ` (Closes #${session.issue})` : ""}`,
        (cx) => this.openPullRequest(prKey, session, ticket, cx));
    }
    if (pr?.state === "OPEN" && checksOutcome(pr) === "failure") {
      if (lifecycle.sentForHead === pr.headRefOid) return h_flex().pl(detailIndent).text_size(11).text_color(t.dim).child("Logs de CI envoyés à l'agent");
      return button("fix-ci", "Corriger la CI", t.ansi1, "Envoie les checks en échec et la fin de leurs logs à l'agent",
        (cx) => this.sendFailingCi(prKey, a, pr, cx));
    }
    if (pr?.state === "MERGED" && sg?.linked) {
      const confirming = (lifecycle.confirmCleanUntil ?? 0) > Date.now();
      return button("clean", confirming ? "Confirmer le nettoyage" : "Nettoyer", t.ansi5,
        "Ferme le space, supprime le worktree et la branche locale",
        (cx) => {
          if ((this.lifecycle[prKey]?.confirmCleanUntil ?? 0) <= Date.now()) {
            this.setLifecycle(prKey, { confirmCleanUntil: Date.now() + CLEAN_CONFIRM_MS }, cx);
            cx.timer.after(CLEAN_CONFIRM_MS, (cx) => cx.notify());
            return;
          }
          this.setLifecycle(prKey, { confirmCleanUntil: 0 }, cx);
          this.cleanUpMerged(prKey, session, pr, cx);
        });
    }
    return null;
  }

  // On the rail a card shrinks to its space's avatar with the status mark on its corner; the tooltip says the rest.
  railSessionCell(a, section, t) {
    const since = this.changed[a.address]?.at;
    const tint = tone(t, a.status);
    const label = [section, a.sessionName, a.space_name, since ? elapsed(Date.now() - since) : null].filter(Boolean).join(" · ");
    return railCell(div()
      .id(`rail-card-${a.address}`)
      .relative()
      .size(RAIL_SESSION_CELL)
      .flex()
      .items_center()
      .justify_center()
      .rounded(8)
      .bg(tint + (a.focused ? "26" : "0d"))
      .cursor_pointer()
      .hover((s) => s.bg(tint + "1c"))
      .tooltip(label)
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(this.spaceMark(a.space, a.space_name, RAIL_SESSION_AVATAR))
      .child(div().absolute().right(0).bottom(0).rounded(5).bg(t.chrome).p(1).child(this.agentStatus(t, a.status))));
  }

  // Every carded session, most urgent first, as rail cells above the space numbers.
  railSessions(sections, t) {
    const cells = sections.flatMap(([section, list]) => list.map((a) => this.railSessionCell(a, section, t)));
    if (cells.length === 0) return null;
    return v_flex().flex_none().pt(6)
      .child(v_flex().id("rail-sessions").max_h(320).gap(6).items_center().overflow_y_scrollbar().children(cells))
      .child(div().mx(10).mt(8).h(1).bg(t.border));
  }

  // A list of session cards above the spaces, under its title and count.
  cardSection(id, label, tint, list, maxHeight, t) {
    const sp = spaces(), ps = panes();
    return v_flex().flex_none().pb(6)
      .child(h_flex().h(31).pl(16).pr(10).gap(6).items_center().text_size(11.5)
        .child(div().text_color(tint).font_medium().child(label))
        .child(div().px(5).h(15).rounded(4).bg(tint + "26").text_size(10.5).font_semibold().text_color(tint).flex().items_center().child(String(list.length))))
      .child(v_flex().id(`${id}-list`).max_h(maxHeight).px(8).gap(6).overflow_y_scrollbar()
        .children(list.map((a) => this.sessionCard(a, this.sessionPlace(a, sp, ps), t))));
  }

  terminalRow(p, tree, t) {
    const pic = agentIcon(p.program, SESSION_ICON, t.muted) ?? h_flex().size(SESSION_ICON).flex_none().items_center().justify_center().child(svg("mods/workspace-chrome/terminal.svg").size(13).text_color(t.dim));
    const busy = !p.program?.shell;
    const name = terminalName(p);
    const folder = folderName(p.cwd);
    return h_flex()
      .id(`space-terminal-${p.pane}`)
      .pl(sessionIndent(tree))
      .pr(8)
      .h(24)
      .flex_none()
      .gap(SESSION_GAP)
      .items_center()
      .rounded(8)
      .text_size(12)
      .cursor_pointer()
      .when(p.focused, (el) => el.bg(t.selected))
      .when(!p.focused, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .child(pic)
      .child(div().flex_1().min_w(0).truncate().text_color(p.focused || busy ? t.foreground : t.muted).child(name))
      .when(folder !== name, (el) => el.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(folder)));
  }

  terminalsBySpace() {
    const agentPanes = new Set(agents().map((a) => a.pane));
    const spaceOf = new Map();
    for (const s of spaces()) for (const tab of s.tabs ?? []) if (!tab.settled) spaceOf.set(tab.id, s.id);
    const bySpace = new Map();
    for (const p of panes()) {
      const space = spaceOf.get(p.tab);
      if (!p.terminal || !space || agentPanes.has(p.pane) || p.program?.agent) continue;
      bySpace.set(space, [...(bySpace.get(space) ?? []), p]);
    }
    return bySpace;
  }

  agentsBySpace() {
    const list = agents();
    this.trackAgentStates(list, Date.now());
    const tabs = new Map(spaces().flatMap((s) => s.tabs ?? []).map((tab) => [tab.id, tab]));
    const bySpace = new Map();
    for (const a of list) {
      const named = { ...a, sessionName: sessionName(a, tabs.get(a.tab)) };
      bySpace.set(a.space, [...(bySpace.get(a.space) ?? []), named]);
    }
    return bySpace;
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    // The Routines space never nests under a repo, even when its first tab runs in one of its worktrees.
    const list = sp.map((w, i) => ({ w, i, g: w.id === routinesSpaceId() ? null : this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Last of its machine's spaces: space.move can't take it past another machine's block.
    const routinesAt = out.findIndex((r) => r.w.id === routinesSpaceId());
    if (routinesAt >= 0) {
      const [routines] = out.splice(routinesAt, 1);
      const sameMachine = (r) => (r.w.machine ?? null) === (routines.w.machine ?? null);
      out.splice(out.findLastIndex(sameMachine) + 1, 0, routines);
    }
    this.foldRoutinesSpaceOnce();
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // With workspaces on, the list shows the selected tab's spaces only.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const store = readWorkspaces();
    const workspaces = store.enabled ? store.list : null;
    // A worktree drawn under its main checkout stays in that checkout's workspace.
    let main = null;
    for (const r of rows) {
      if (!r.tree) main = r;
      r.ws = r.tree && main ? main.ws : workspaceOfSpace(store, r.w.id);
    }
    this.lastRows = rows;
    const rowsOf = (ws) => rows.filter((r) => r.ws === ws.id);
    const shownRows = workspaces ? workspaces.flatMap(rowsOf) : rows;
    const bySpace = collapsed ? new Map() : this.agentsBySpace();
    const terminalsBySpace = collapsed ? new Map() : this.terminalsBySpace();
    setAgentOrder(shownRows.flatMap((r) => (bySpace.get(r.w.id) ?? []).map((a) => a.address)));
    const sessionsOf = (r) => bySpace.get(r.w.id) ?? [];
    const drawSpace = (r) => (collapsed ? this.compact(r, t) : this.row(r, t, sessionsOf(r)));
    const shownAgents = (r) => (this.foldedSpaces.has(r.w.id) ? [] : sessionsOf(r));
    const shownTerminals = (r) => (this.foldedSpaces.has(r.w.id) ? [] : terminalsBySpace.get(r.w.id) ?? []);
    const drawAll = (list) => list.flatMap((r) => [
      drawSpace(r),
      ...shownAgents(r).map((a) => this.agentRow(a, r.tree, t)),
      ...shownTerminals(r).map((p) => this.terminalRow(p, r.tree, t)),
    ]);
    const rowsUnder = (r) => shownAgents(r).length + shownTerminals(r).length;
    const childIndexOf = (list, found) => found < 0 ? -1 : list.slice(0, found).reduce((n, r) => n + 1 + rowsUnder(r), 0);
    const draw = { drawAll, childIndexOf };
    if (!workspaces) return this.machineItems(rows, t, collapsed, draw, true);
    const shown = workspaces.find((ws) => ws.id === this.shownWorkspace(store, rows));
    // Machines without spaces yet are offered in the default workspace only.
    const section = this.machineItems(rowsOf(shown), t, collapsed, draw, shown.id === DEFAULT_WORKSPACE.id);
    return section.length ? section : [this.emptyWorkspace(shown, t, collapsed)];
  }

  // Sets this.activeAt to where the active space's row lands among the children this returns: the list
  // scrolls by its direct children, and machine headers, login notes and loading rows count too.
  machineItems(rows, t, collapsed, { drawAll, childIndexOf }, withIdleMachines) {
    this.activeAt = -1;
    let before = 0;
    const idleMachines = withIdleMachines ? [...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)] : [];
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...idleMachines])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      this.activeAt = childIndexOf(rows, rows.findIndex(r => r.w.active));
      return drawAll(rows);
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const items = [cell(head), ...guidance, ...(folded ? [] : mine.length ? drawAll(mine) : [loading(m) ? loadingRow(m) : cell(empty)])];
      const first = folded ? -1 : childIndexOf(mine, mine.findIndex(r => r.w.active));
      if (first >= 0) this.activeAt = before + 1 + guidance.length + first;
      before += items.length;
      return items;
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one. When the row is full, it
  // and the name both start from their text's width and give way in proportion.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // Shown on a folded space: one pill per CLI (Claude, OpenCode, ...) with its session count,
  // tinted by the most urgent of its sessions.
  sessionCounters(w, sessions, t) {
    const byCli = new Map();
    for (const a of sessions) {
      const cli = a.program?.key ?? a.app ?? "agent";
      byCli.set(cli, [...(byCli.get(cli) ?? []), a]);
    }
    return h_flex().flex_none().gap(4).items_center().children([...byCli].map(([cli, list]) => {
      const urgent = ["blocked", "done", "working"].find((s) => list.some((a) => a.status === s));
      const color = urgent ? tone(t, urgent) : t.muted;
      const program = list[0].program;
      const label = program?.name || list[0].app || "Agent";
      const working = list.filter((a) => a.status === "working").length;
      const blocked = list.filter((a) => a.status === "blocked").length;
      const count = working > 0 ? `${working}/${list.length}` : String(list.length);
      const detail = [
        working && `${working} en cours`,
        blocked && `${blocked} bloquée${blocked > 1 ? "s" : ""}`,
        list.length - working - blocked && `${list.length - working - blocked} au repos`,
      ].filter(Boolean).join(", ");
      return h_flex().id(`space-sessions-${w.id}-${cli}`).flex_none().h(18).px(5).gap(3).rounded(4).items_center()
        .bg(color + "22").text_size(10.5).font_semibold().text_color(color)
        .tooltip(`${label} · ${list.length} session${list.length > 1 ? "s" : ""} : ${detail}`)
        .when(Boolean(program?.icon), (el) => el.child(agentIcon(program, 13, color)))
        .when(!program?.icon, (el) => el.child(label))
        .child(count)
        .when(working > 0, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(tone(t, "working")).spin(900)));
    }));
  }

  foldToggle(w, folded, t) {
    return h_flex().id(`space-fold-${w.id}`).flex_none().size(22).rounded(4).items_center().justify_center()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(folded ? "Déplier" : "Replier")
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.toggleSpaceFold(w.id, cx); })
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(14));
  }

  row({ w, i, g, tree, ws }, t, sessions = []) {
    const folded = this.foldedSpaces.has(w.id);
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const sourceWorkspace = this.lastRows.find(r => r.w.id === this.pressed)?.ws;
        // space.move stays within a machine; changing workspace works across machines.
        const takes = source && (sourceWorkspace !== ws || (source.machine ?? null) === (w.machine ?? null));
        const over = takes ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          if (readWorkspaces().enabled) this.moveToWorkspace(from, ws);
          const source = spaces().find(s => s.id === from);
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1 && (source?.machine ?? null) === (w.machine ?? null)) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(tree ? SESSION_GAP : 9)
          .items_center()
          .when(Boolean(tree), el => el.pl(WORKTREE_ICON_INDENT).child(h_flex().size(SESSION_ICON).flex_none().items_center().justify_center().child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim))))
          .when(!tree && w.id === routinesSpaceId(), el => el.child(routinesMark(18, t)))
          .when(!tree && w.id !== routinesSpaceId(), el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(folded && sessions.length > 0, (el) => el.child(this.sessionCounters(w, sessions, t)))
          .child(this.foldToggle(w, folded, t)),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  // Herdr's own settings, with a dot when an app update is ready: the native footer that held it is not in this layout.
  herdrSettingsButton(t, collapsed) {
    const updateReady = div().size(6).rounded_full().bg(t.accent);
    return h_flex().flex_none().border_t(1).border_color(t.border).px(8).pt(4).pb(8)
      .when(collapsed, (el) => el.px(0).justify_center())
      .child(h_flex().id("herdr-settings").flex_1().h(28).px(8).gap(9).items_center().rounded(8).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .when(collapsed, (el) => el.flex_none().relative().w(32).px(0).justify_center().tooltip("Settings"))
        .on_click(() => run("app.settings"))
        .child(svg("mods/workspace-chrome/settings.svg").size(14))
        .when(!collapsed, (el) => el.child(div().flex_1().child("Settings")))
        .when(Boolean(updates().app.ready), (el) => el.child(collapsed ? updateReady.absolute().top(5).right(6) : updateReady)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    const blocked = this.agentsWithStatus("blocked");
    const working = this.agentsWithStatus("working").filter((a) => !isRoutineSession(a));
    const now = Date.now();
    const resting = this.agentsWithStatus(...RESTING_STATUSES).filter((a) => this.restedRecently(a, now) && !isRoutineSession(a));
    const railSessions = collapsed ? this.railSessions([["Needs you", blocked], ["En cours", working], ["Au repos", resting]], t) : null;
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .when(Boolean(railSessions), (el) => el.child(railSessions))
      .when(!collapsed && blocked.length > 0, (el) => el.child(this.cardSection("needs-you", "Needs you", t.blocked, blocked, 260, t)))
      .when(!collapsed && working.length > 0, (el) => el.child(this.cardSection("working", "En cours", t.working, working, 300, t)))
      .when(!collapsed && resting.length > 0, (el) => el.child(this.cardSection("resting", "Au repos", t.idle ?? t.dim, resting, 260, t)))
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child(div().flex_1().child("Spaces")))
        .when(!collapsed, el => el.child(div().id("space-fold-all").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.allSpacesFolded() ? "Tout déplier" : "Tout replier")
          .on_click((_e, cx) => this.toggleAllSpacesFold(cx))
          .child(svg(`mods/benni-spaces/chevrons-${this.allSpacesFolded() ? "up-down" : "down-up"}.svg`).size(14))))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => {
            if (readWorkspaces().enabled) this.newSpaceIn(this.selectedWorkspace);
            else run("space.new");
          }).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .when(readWorkspaces().enabled, (el) => el.child(this.workspaceTabs(t, collapsed)))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(list))
      .child(this.herdrSettingsButton(t, collapsed))
      .when(collapsed, el => el.child(h_flex().h(44).flex_none().items_center().justify_center()
        .child(div().id("sidebar-unfold").size(32).flex().items_center().justify_center().rounded(6)
          .text_size(24).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Déplier la barre latérale").on_click(toggleSidebar).child("»"))));
  }
}
