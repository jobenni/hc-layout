import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, agents, terminals, focused, exec, readTextFile, theme, window, layout, props, run, appHome, home, checking } from "herdr";
import {
  readWorktrees, issueBranchNumber, issueBranchName, defaultBaseRef, addWorktree,
  hasUncommittedChanges, removeWorktreeAndBranch,
} from "./git.js";
import { forgeOf, checksSummary, isPullRequestFinished } from "./forge.js";

const REFRESH_EVERY_MS = 30000;
const ICONS = "mods/gh-issues/icons";
const PROMPT_DRAFT_PLUGIN = `${appHome()}/mods/gh-issues/claude-draft`;
// Through the user's own shell, so a `claude` function or alias in their rc file
// (e.g. one picking a Claude profile from the folder) applies.
const CLAUDE_VIA_LOGIN_SHELL = [
  'case "${SHELL##*/}" in',
  '  fish) exec "$SHELL" -c \'claude $argv\' -- "$@" ;;',
  '  bash|zsh) exec "$SHELL" -ic \'claude "$@"\' claude "$@" ;;',
  "esac",
  'exec claude "$@"',
].join("\n");
const OUTCOME_GLYPH = { success: "✓", failure: "✗", pending: "●", skipped: "○", none: "" };
const PR_STATE_LABEL = { OPEN: "ouverte", MERGED: "fusionnée", CLOSED: "fermée" };
const SPACE_CLOSE_WAIT_MS = 10000;
const BUSY_AGENT_STATUSES = new Set(["working", "blocked"]);

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, branch: pane?.branch ?? space?.branch ?? null };
}

function isInside(folder, root) {
  return Boolean(folder) && (folder === root || folder.startsWith(`${root}/`));
}

function isSpaceIn(space, folder) {
  return isInside(space.folder, folder)
    || space.tabs.some((tab) => panes().some((p) => p.tab === tab.id && isInside(p.cwd, folder)));
}

function spaceShowing(folder) {
  return spaces().find((s) => isSpaceIn(s, folder));
}

function spacesIn(folder, on) {
  return spaces().filter((s) => (s.machine ?? null) === (on ?? null) && isSpaceIn(s, folder));
}

function terminalsOf(spaceList) {
  const tabs = new Set(spaceList.flatMap((s) => s.tabs.map((tab) => tab.id)));
  return panes().filter((p) => p.terminal && tabs.has(p.tab));
}

function busyAgentCount(spaceList) {
  const inThoseSpaces = new Set(terminalsOf(spaceList).map((p) => p.pane));
  return agents().filter((a) => inThoseSpaces.has(a.pane) && BUSY_AGENT_STATUSES.has(a.status)).length;
}

// Shown when this copy is a pane, or when its block is the active child of a visible stack.
function isBlockShown(node, hiddenAbove = false) {
  if (!node || typeof node !== "object") return false;
  const hidden = hiddenAbove || node.hidden === true;
  for (const child of node.children ?? []) {
    if (child.content?.mod === "gh-issues") {
      const isActiveInStack = node.type !== "stack" || node.active === child.id;
      if (!hidden && !child.hidden && isActiveInStack) return true;
    } else if (isBlockShown(child, hidden)) return true;
  }
  return false;
}

const DRAFT_PLUGIN_FILES = [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/register.ts"];

async function homeOf(on) {
  if (!on) return home();
  const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
  if (result.code !== 0 || !result.stdout) throw new Error(`dossier personnel introuvable sur ${on}`);
  return result.stdout;
}

// Like the shipped New worktree dialog: the setting's ~ is the home of the space's machine.
async function worktreesDirectory(machineHome) {
  let directory = "~/.herdr/worktrees";
  try { directory = JSON.parse(await readTextFile(`${appHome()}/settings.json`) ?? "{}")?.worktrees?.directory ?? directory; } catch {}
  return directory.replace(/^~(?=\/|$)/, machineHome);
}

// Claude runs on the space's machine, so the draft plugin must be on that machine's disk.
async function draftPluginOn(on, machineHome) {
  if (!on) return PROMPT_DRAFT_PLUGIN;
  const target = `${machineHome}/.cache/herdr-gh-issues/claude-draft`;
  for (const file of DRAFT_PLUGIN_FILES) {
    const text = await readTextFile(`${PROMPT_DRAFT_PLUGIN}/${file}`);
    const result = await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf %s "$2" > "$1"', "sh", `${target}/${file}`, text ?? ""], { on });
    if (result.code !== 0) throw new Error(`copie du plugin de brouillon sur ${on} impossible`);
  }
  return target;
}

function pullRequestLook(pr, t) {
  if (pr.state === "MERGED") return { icon: `${ICONS}/pr-merged.svg`, color: t.ansi5 };
  if (pr.state === "CLOSED") return { icon: `${ICONS}/pr-closed.svg`, color: t.ansi1 };
  if (pr.isDraft) return { icon: `${ICONS}/pr-draft.svg`, color: t.dim };
  return { icon: `${ICONS}/pr-open.svg`, color: t.ansi2 };
}

// "Johan BONASSI" gives JB; a single word, like a GitHub login, gives its first two letters.
function initialsOf(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return letters.toUpperCase() || "?";
}
// The app's own opener on macOS and Windows; under Linux it may run inside WSL, where
// xdg-open has nothing to hand the URL to, so Windows' browser gets it instead.
const OPEN_ON_LINUX = 'if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then command -v wslview >/dev/null 2>&1 && exec wslview "$1"; exec explorer.exe "$1"; fi; exec xdg-open "$1"';
const openUrl = (url, cx) => {
  if (!url) return;
  if (window()?.platform === "linux") exec("sh", ["-c", OPEN_ON_LINUX, "sh", url]);
  else cx.open_url(url);
};

export default class GhIssues extends View {
  init(_props, cx) {
    this.repo = null;
    this.forge = null;
    this.viewer = null;
    this.issues = [];
    this.scope = null;
    this.sessions = new Map();
    this.linkedWorktrees = [];
    this.pullRequests = new Map();
    this.uncommitted = new Set();
    this.cleanupConfirming = null;
    this.cleaningPath = null;
    this.cleanupReport = "";
    this.launching = null;
    this.assigning = null;
    this.loading = false;
    this.error = "";
    this.note = "";
    this.cwd = undefined;
    this.onlyMine = false;
    try { this.onlyMine = localStorage.getItem("onlyMine") === "true"; } catch {}
    if (checking()) return;
    cx.timer.every(REFRESH_EVERY_MS, (cx) => {
      if (window()?.visible !== false && this.isShown()) { this.refresh(cx, { withGithub: true }); cx.notify(); }
    });
  }

  isShown() {
    return Boolean(props()?.pane) || isBlockShown(layout());
  }

  refresh(cx, { withGithub }) {
    if (this.loading) return;
    const { cwd, on, branch } = location();
    if (!cwd) { this.repo = null; this.forge = null; this.issues = []; this.scope = null; this.error = "Aucun dossier"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const worktrees = await readWorktrees(cwd, on);
        const main = worktrees[0]?.path;
        const repoChanged = main !== this.repo?.main || on !== this.repo?.on;
        this.repo = { main, name: main?.split("/").pop(), on };
        if (repoChanged || !this.forge) { this.forge = await forgeOf(main, on); this.viewer = null; }
        const forge = this.forge;
        this.linkedWorktrees = worktrees.slice(1).filter((w) => w.branch);
        this.sessions = new Map(this.linkedWorktrees
          .map((w) => [issueBranchNumber(w.branch), w])
          .filter(([number]) => number !== null));
        if (repoChanged) { this.issues = []; this.scope = null; this.pullRequests = new Map(); this.cleanupConfirming = null; this.cleanupReport = ""; }
        if (withGithub || repoChanged) {
          // A merged or closed PR stays so: its branch is not asked again.
          const finished = new Map([...this.pullRequests].filter(([, pr]) => isPullRequestFinished(pr)));
          const branches = [branch, ...this.linkedWorktrees.map((w) => w.branch)].filter((b) => !finished.has(b));
          const [{ issues, scope }, pullRequests, viewer] = await Promise.all([
            forge.readOpenIssues(),
            forge.readPullRequests(branches),
            this.viewer ?? forge.readViewer().catch(() => null),
          ]);
          this.issues = issues;
          this.scope = scope;
          this.pullRequests = new Map([...finished, ...pullRequests]);
          this.viewer = viewer;
        }
        this.uncommitted = await this.findUncommitted(this.finishedWorktrees(), on);
        this.error = "";
      } catch (error) {
        this.error = String(error?.message ?? error);
        if (/not a git repository/i.test(this.error)) { this.repo = null; this.forge = null; this.issues = []; this.scope = null; this.error = "Pas un dépôt Git"; }
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  launch(issue, cx) {
    const { on } = this.repo ?? {};
    this.launching = issue.number;
    this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const branch = issueBranchName(issue);
        const machineHome = await homeOf(on);
        const path = `${await worktreesDirectory(machineHome)}/${this.repo.name}/${branch}`;
        const baseRef = await defaultBaseRef(this.repo.main, on);
        await addWorktree(this.repo.main, path, branch, baseRef, on);
        const pluginDir = await draftPluginOn(on, machineHome);
        run("space.new", {
          folder: path,
          machine: on ?? "",
          tab: `#${issue.number}`,
          argv: ["env", `CLAUDE_PROMPT_DRAFT=${this.forge.workPrompt(issue)}`, "sh", "-c", CLAUDE_VIA_LOGIN_SHELL, "sh", "--plugin-dir", pluginDir],
        });
      } catch (error) {
        this.note = `Lancement impossible : ${error?.message ?? error}`;
      } finally {
        this.launching = null;
        cx.notify();
        this.refresh(cx, { withGithub: false });
      }
    });
  }

  toggleSelfAssigned(issue, cx) {
    const isAssigned = this.isAssignedToViewer(issue);
    this.assigning = issue.number;
    this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        issue.assignees = await this.forge.setSelfAssigned(issue, this.viewer, !isAssigned);
      } catch (error) {
        this.note = `Affectation impossible : ${error?.message ?? error}`;
      } finally {
        this.assigning = null;
        cx.notify();
      }
    });
  }

  toggleOnlyMine(cx) {
    this.onlyMine = !this.onlyMine;
    try { localStorage.setItem("onlyMine", String(this.onlyMine)); } catch {}
    cx.notify();
  }

  shownIssues() {
    return this.onlyMine ? this.issues.filter((issue) => this.isAssignedToViewer(issue)) : this.issues;
  }

  isAssignedToViewer(issue) {
    return Boolean(this.viewer) && (issue.assignees ?? []).some((a) => a.id === this.viewer.id);
  }

  openSession(session) {
    const space = spaceShowing(session.path);
    if (space) run("space.select", { id: space.id });
    else run("space.new", { folder: session.path, machine: this.repo?.on ?? "" });
  }

  // Linked worktrees whose PR is merged or closed: what is left to clean up.
  finishedWorktrees() {
    return this.linkedWorktrees.filter((w) => isPullRequestFinished(this.pullRequests.get(w.branch)));
  }

  async findUncommitted(worktrees, on) {
    const dirty = await Promise.all(worktrees.map((w) =>
      w.isFolderMissing ? false : hasUncommittedChanges(w.path, on).catch(() => true)));
    return new Set(worktrees.filter((_w, index) => dirty[index]).map((w) => w.path));
  }

  cleanableWorktrees() {
    return this.finishedWorktrees().filter((w) => !this.uncommitted.has(w.path));
  }

  // Each worktree in turn: its spaces close (and their terminals end), then the worktree and its
  // branch go. Changes made since the last refresh stop that one, not the others.
  cleanUp(paths, cx) {
    const { main, on } = this.repo ?? {};
    const worktrees = this.cleanableWorktrees().filter((w) => paths.includes(w.path));
    if (!main || !worktrees.length) return;
    this.cleanupConfirming = null;
    this.cleanupReport = "";
    cx.notify();
    cx.spawn(async (cx) => {
      const removed = [], kept = [], failed = [];
      for (const worktree of worktrees) {
        this.cleaningPath = worktree.path;
        cx.notify();
        try {
          if (!worktree.isFolderMissing && await hasUncommittedChanges(worktree.path, on)) throw new Error("modifications non commitées");
          const closing = spacesIn(worktree.path, on);
          const closingTerminals = new Set(terminalsOf(closing).map((p) => p.terminal));
          for (const space of closing) run("space.close", { id: space.id, confirmed: true });
          const deadline = Date.now() + SPACE_CLOSE_WAIT_MS;
          while (terminals().some((k) => k.state === "live" && closingTerminals.has(k.address))) {
            if (Date.now() >= deadline) throw new Error("les terminaux du space ne se sont pas arrêtés");
            await cx.sleep(50);
          }
          const whyBranchKept = await removeWorktreeAndBranch(main, worktree, this.pullRequests.get(worktree.branch), on);
          (whyBranchKept ? kept : removed).push(worktree.branch);
        } catch (error) {
          failed.push(`${worktree.branch} (${error?.message ?? error})`);
        }
      }
      this.cleaningPath = null;
      this.cleanupReport = [
        removed.length && `${removed.length} nettoyé${removed.length > 1 ? "s" : ""}`,
        kept.length && `branche gardée, commits absents de la PR : ${kept.join(", ")}`,
        failed.length && `échec : ${failed.join(", ")}`,
      ].filter(Boolean).join(" · ");
      cx.notify();
      this.refresh(cx, { withGithub: false });
    });
  }

  render(cx) {
    const here = location();
    if (here.cwd !== this.cwd) {
      this.cwd = here.cwd;
      if (!checking()) this.refresh(cx, { withGithub: false });
    }
    const t = theme();
    const currentPr = here.branch ? this.pullRequests.get(here.branch) : null;
    const issues = this.shownIssues();
    return v_flex().id("gh-issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .when(Boolean(currentPr), (el) => el.child(this.currentSessionCard(currentPr, t)))
      .when(Boolean(this.note), (el) => el.child(div().px(14).py(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("gh-issues-list").absolute().inset_0().overflow_y_scroll().p(6).gap(2)
          .when(this.finishedWorktrees().length > 0 || Boolean(this.cleanupReport), (el) => el.child(this.worktreesSection(t)))
          .children(issues.map((issue) => this.issueRow(issue, t)))
          .when(!issues.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.emptyText()))))
        .child(Scrollbar.vertical("gh-issues-list").absolute().inset_0()));
  }

  emptyText() {
    if (this.error) return this.error;
    if (this.loading) return "Chargement des issues…";
    if (!this.repo) return "Aucun dépôt";
    if (this.onlyMine && this.issues.length) return "Aucune issue ouverte ne t'est assignée";
    return this.forge?.name === "Azure DevOps" ? "Aucun work item ouvert dans le sprint en cours" : "Aucune issue ouverte";
  }

  repoLabel() {
    if (!this.repo?.name) return "";
    return [this.repo.name, this.repo.on, this.scope].filter(Boolean).join(" · ");
  }

  header(t) {
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Issues"))
      .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
        .child(`${this.shownIssues().length} ouvertes`))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.repoLabel()))
      .child(div().id("gh-issues-only-mine").h(22).px(8).flex().items_center().rounded(6).text_size(11).cursor_pointer()
        .border_1().border_color(this.onlyMine ? t.accent : t.border)
        .bg(this.onlyMine ? t.selected : t.background).text_color(this.onlyMine ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleOnlyMine(cx))
        .child("Mes issues"))
      .child(div().id("gh-issues-refresh").w(22).h(22).flex().items_center().justify_center().rounded(6)
        .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.refresh(cx, { withGithub: true }); cx.notify(); })
        .child(this.loading ? div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90) : "↻"));
  }

  currentSessionCard(pr, t) {
    return v_flex().flex_none().m(6).p(8).gap(6).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.muted).child("PR de cette session"))
      .child(this.pullRequestBlock(pr, t, "current"));
  }

  assigneeBadges(issue, t) {
    const assignees = issue.assignees ?? [];
    const isAssigning = this.assigning === issue.number;
    const canAssignSelf = Boolean(this.viewer) && !this.isAssignedToViewer(issue);
    const replaced = this.forge?.hasSingleAssignee ? assignees[0] : null;
    return h_flex().flex_none().gap(2).items_center()
      .children(assignees.slice(0, 3).map((a) => a.id === this.viewer?.id
        ? this.viewerBadge(issue, isAssigning, t)
        : this.badge(t.raised, t.muted).id(`assignee-${issue.number}-${a.id}`).tooltip(a.name).child(initialsOf(a.name))))
      .when(assignees.length > 3, (el) => el.child(div().text_size(10).text_color(t.dim).child(`+${assignees.length - 3}`)))
      .when(canAssignSelf, (el) => el.child(this.badge(t.background, t.dim).id(`assign-${issue.number}`)
        .border_1().border_color(t.border).cursor_pointer().tooltip(replaced ? `M'assigner (remplace ${replaced.name})` : "M'assigner")
        .hover((s) => s.text_color(t.foreground).border_color(t.accent))
        .on_click((_e, cx) => { if (!isAssigning) this.toggleSelfAssigned(issue, cx); })
        .child(isAssigning ? "…" : "+")));
  }

  viewerBadge(issue, isAssigning, t) {
    return this.badge(t.accent, t.accent_foreground).id(`unassign-${issue.number}`).cursor_pointer().tooltip("Me retirer")
      .hover((s) => s.bg(t.ansi1).text_color("#ffffff"))
      .on_click((_e, cx) => { if (!isAssigning) this.toggleSelfAssigned(issue, cx); })
      .child(isAssigning ? "…" : initialsOf(this.viewer.name));
  }

  badge(background, color) {
    return div().w(18).h(18).flex().flex_none().items_center().justify_center().rounded_full().text_size(9).font_semibold()
      .bg(background).text_color(color);
  }

  claudeButton(issue, session, t) {
    const isLaunching = this.launching === issue.number;
    return div().id(`claude-${issue.number}`).w(22).h(22).flex().flex_none().items_center().justify_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.raised))
      .tooltip(session ? "Ouvrir la session" : isLaunching ? "Création du worktree…" : "Lancer Claude")
      .on_click((_e, cx) => {
        if (session) this.openSession(session);
        else if (!isLaunching) this.launch(issue, cx);
      })
      .child(isLaunching
        ? div().text_size(11).text_color(t.muted).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)
        : svg(`${ICONS}/claude.svg`).size(14).text_color("#D97757"));
  }

  issueRow(issue, t) {
    const session = this.sessions.get(issue.number);
    const pr = session ? this.pullRequests.get(session.branch) : null;
    const summary = pr ? checksSummary(pr.checks) : "none";
    return h_flex().id(`issue-${issue.number}`).flex_none().h(30).px(8).gap(8).items_center().rounded(7)
      .hover((s) => s.bg(t.hover))
      .child(svg(`${ICONS}/issue.svg`).size(14).flex_none().text_color(t.ansi2))
      .child(div().id(`issue-link-${issue.number}`).w(40).flex_none().text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.accent)).tooltip(`Voir sur ${this.forge?.name ?? "GitHub"}`)
        .on_click((_e, cx) => openUrl(issue.url, cx)).child(`#${issue.number}`))
      .child(div().flex_1().min_w(0).truncate().child(issue.title))
      .when(Boolean(session), (el) => el.child(div().flex_none().px(5).py(1).rounded(4).text_size(10)
        .bg(t.raised).text_color(t.muted).child("session")))
      .when(Boolean(pr), (el) => {
        const look = pullRequestLook(pr, t);
        return el.child(h_flex().id(`issue-pr-${issue.number}`).flex_none().gap(3).items_center().text_size(11).cursor_pointer()
          .on_click((_e, cx) => openUrl(pr.url, cx))
          .child(svg(look.icon).size(13).text_color(look.color))
          .child(div().text_color(this.outcomeColor(summary, t)).child(`#${pr.number} ${OUTCOME_GLYPH[summary]}`)));
      })
      .child(this.assigneeBadges(issue, t))
      .child(this.claudeButton(issue, session, t));
  }

  pullRequestBlock(pr, t, scope) {
    const steps = pr.checks;
    const look = pullRequestLook(pr, t);
    const stateLabel = pr.isDraft && pr.state === "OPEN" ? "brouillon" : PR_STATE_LABEL[pr.state] ?? pr.state.toLowerCase();
    return v_flex().gap(4)
      .child(h_flex().id(`pr-${scope}-${pr.number}`).gap(6).items_center().cursor_pointer().on_click((_e, cx) => openUrl(pr.url, cx))
        .child(svg(look.icon).size(14).flex_none().text_color(look.color))
        .child(div().flex_none().text_size(11).text_color(t.accent).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        .child(div().flex_none().px(5).py(1).rounded(4).text_size(10).bg(t.raised).text_color(look.color).child(stateLabel)))
      .when(!steps.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("Aucun check")))
      .children(steps.map((step, index) =>
        h_flex().id(`check-${scope}-${pr.number}-${index}`).h(22).px(4).gap(6).items_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => openUrl(step.url, cx))
          .child(step.outcome === "pending"
            ? div().w(12).flex_none().text_color(t.working).frames(["◐", "◓", "◑", "◒"], 160)
            : div().w(12).flex_none().text_color(this.outcomeColor(step.outcome, t)).child(OUTCOME_GLYPH[step.outcome]))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(step.name))));
  }

  worktreesSection(t) {
    const finished = this.finishedWorktrees();
    const cleanable = this.cleanableWorktrees();
    const isCleaning = Boolean(this.cleaningPath);
    return v_flex().flex_none().mb(6).p(6).gap(2).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().h(26).px(4).gap(6).items_center()
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("Worktrees à nettoyer"))
        .child(div().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).child(String(finished.length)))
        .child(div().flex_1())
        .when(cleanable.length > 1 && !isCleaning && !this.cleanupConfirming, (el) => el.child(
          this.actionButton("worktrees-clean-all", `Nettoyer les ${cleanable.length}`, t, false,
            (cx) => { this.cleanupConfirming = cleanable.map((w) => w.path); cx.notify(); }))))
      .when(Boolean(this.cleanupConfirming), (el) => el.child(this.cleanupConfirmation(t)))
      .children(finished.map((worktree) => this.worktreeRow(worktree, t)))
      .when(Boolean(this.cleanupReport), (el) => el.child(div().px(4).py(2).text_size(11).text_color(t.muted).child(this.cleanupReport)));
  }

  worktreeRow(worktree, t) {
    const pr = this.pullRequests.get(worktree.branch);
    const look = pullRequestLook(pr, t);
    const isDirty = this.uncommitted.has(worktree.path);
    const isCleaning = this.cleaningPath === worktree.path;
    const canOffer = !isDirty && !this.cleaningPath && !this.cleanupConfirming;
    return h_flex().id(`worktree-${worktree.path}`).h(30).px(4).gap(6).items_center().rounded(6)
      .child(svg(look.icon).size(13).flex_none().text_color(look.color))
      .child(div().id(`worktree-pr-${worktree.path}`).flex_none().text_size(11).text_color(look.color).cursor_pointer()
        .on_click((_e, cx) => openUrl(pr.url, cx)).child(`#${pr.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(worktree.branch))
      .when(worktree.isFolderMissing, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("dossier absent")))
      .when(isDirty, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi3).child("non commité")))
      .when(isCleaning, (el) => el.child(div().flex_none().text_size(11).text_color(t.muted)
        .child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))))
      .when(canOffer, (el) => el.child(div().id(`worktree-clean-${worktree.path}`).h(22).px(8).flex().flex_none().items_center()
        .rounded(6).text_size(11).cursor_pointer().text_color(t.ansi5).bg(t.ansi5 + "1a").border_1().border_color(t.ansi5 + "55")
        .on_click((_e, cx) => { this.cleanupConfirming = [worktree.path]; cx.notify(); })
        .child("Nettoyer")));
  }

  cleanupConfirmation(t) {
    const worktrees = this.cleanableWorktrees().filter((w) => this.cleanupConfirming.includes(w.path));
    const closing = worktrees.flatMap((w) => spacesIn(w.path, this.repo?.on));
    const busyAgents = busyAgentCount(closing);
    const what = worktrees.length === 1 ? `le worktree et la branche ${worktrees[0].branch}` : `${worktrees.length} worktrees et leurs branches`;
    return v_flex().p(8).gap(6).rounded(6).bg(t.background).border_1().border_color(t.ansi1 + "55").text_size(12)
      .child(div().child(`Supprimer ${what} ?`))
      .when(closing.length > 0, (el) => el.child(div().text_size(11).text_color(t.muted)
        .child(`Space${closing.length > 1 ? "s" : ""} fermé${closing.length > 1 ? "s" : ""} : ${closing.map((s) => s.name).join(", ")}`)))
      .when(busyAgents > 0, (el) => el.child(div().text_size(11).text_color(t.ansi1)
        .child(`${busyAgents} agent${busyAgents > 1 ? "s" : ""} en cours ${busyAgents > 1 ? "seront arrêtés" : "sera arrêté"}`)))
      .child(h_flex().gap(6)
        .child(div().id("worktrees-clean-confirm").h(26).px(10).flex().items_center().rounded(6).cursor_pointer()
          .bg(t.ansi1).text_color("#ffffff").on_click((_e, cx) => this.cleanUp(this.cleanupConfirming, cx)).child("Supprimer"))
        .child(this.actionButton("worktrees-clean-cancel", "Annuler", t, false, (cx) => { this.cleanupConfirming = null; cx.notify(); })));
  }

  actionButton(id, label, t, isPrimary, onPress) {
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(isPrimary ? t.solid : t.raised).text_color(isPrimary ? t.solid_foreground : t.foreground)
      .on_click((_e, cx) => onPress(cx)).child(label);
  }

  outcomeColor(outcome, t) {
    return { success: t.ansi2, failure: t.ansi1, pending: t.working, skipped: t.dim, none: t.dim }[outcome];
  }
}
