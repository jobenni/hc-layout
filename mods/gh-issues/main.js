import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, window, layout, props, run, appHome, home, checking } from "herdr";
import {
  readWorktrees, readOpenIssues, readPullRequests, readViewerLogin, setSelfAssigned,
  issueBranchNumber, issueBranchName, checkSteps, checksSummary, defaultBaseRef, addWorktree,
} from "./github.js";

const REFRESH_EVERY_MS = 30000;
const ICONS = "mods/gh-issues/icons";
const PROMPT_DRAFT_PLUGIN = `${appHome()}/mods/gh-issues/claude-draft`;
const OUTCOME_GLYPH = { success: "✓", failure: "✗", pending: "●", skipped: "○", none: "" };
const PR_STATE_LABEL = { OPEN: "ouverte", MERGED: "fusionnée", CLOSED: "fermée" };

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, branch: pane?.branch ?? space?.branch ?? null };
}

function isInside(folder, root) {
  return Boolean(folder) && (folder === root || folder.startsWith(`${root}/`));
}

function spaceShowing(folder) {
  return spaces().find((s) => isInside(s.folder, folder)
    || s.tabs.some((tab) => panes().some((p) => p.tab === tab.id && isInside(p.cwd, folder))));
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

function readableTextOn(hexColor) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hexColor.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#1f2328" : "#ffffff";
}

const initialsOf = (login) => login.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
const openUrl = (url) => { if (url) exec("open", [url]); };

export default class GhIssues extends View {
  init(_props, cx) {
    this.repo = null;
    this.viewer = null;
    this.issues = [];
    this.sessions = new Map();
    this.pullRequests = new Map();
    this.expanded = null;
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
    if (!cwd) { this.repo = null; this.issues = []; this.error = "Aucun dossier"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const worktrees = await readWorktrees(cwd, on);
        const main = worktrees[0]?.path;
        const repoChanged = main !== this.repo?.main;
        this.repo = { main, name: main?.split("/").pop(), on };
        this.sessions = new Map(worktrees.slice(1)
          .map((w) => [issueBranchNumber(w.branch), w])
          .filter(([number]) => number !== null));
        if (withGithub || repoChanged) {
          const branches = [branch, ...[...this.sessions.values()].map((s) => s.branch)];
          const [issues, pullRequests, viewer] = await Promise.all([
            readOpenIssues(main, on),
            readPullRequests(branches, main, on),
            this.viewer && !repoChanged ? this.viewer : readViewerLogin(main, on).catch(() => null),
          ]);
          this.issues = issues;
          this.pullRequests = pullRequests;
          this.viewer = viewer;
        }
        this.error = "";
      } catch (error) {
        this.error = String(error?.message ?? error);
        if (/not a git repository/i.test(this.error)) { this.repo = null; this.issues = []; this.error = "Pas un dépôt Git"; }
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
          argv: ["env", `CLAUDE_PROMPT_DRAFT=Traite l'issue ${issue.url}`, "claude", "--plugin-dir", pluginDir],
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
        await setSelfAssigned(issue.number, !isAssigned, this.repo.main, this.repo.on);
        issue.assignees = isAssigned
          ? issue.assignees.filter((a) => a.login !== this.viewer)
          : [...(issue.assignees ?? []), { login: this.viewer ?? "moi" }];
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
    return Boolean(this.viewer) && (issue.assignees ?? []).some((a) => a.login === this.viewer);
  }

  openSession(session) {
    const space = spaceShowing(session.path);
    if (space) run("space.select", { id: space.id });
    else run("space.new", { folder: session.path, machine: this.repo?.on ?? "" });
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
          .children(issues.map((issue) => this.issueRow(issue, t)))
          .when(!issues.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.emptyText()))))
        .child(Scrollbar.vertical("gh-issues-list").absolute().inset_0()));
  }

  emptyText() {
    if (this.error) return this.error;
    if (this.loading) return "Chargement des issues…";
    if (!this.repo) return "Aucun dépôt";
    return this.onlyMine && this.issues.length ? "Aucune issue ouverte ne t'est assignée" : "Aucune issue ouverte";
  }

  repoLabel() {
    if (!this.repo?.name) return "";
    return this.repo.on ? `${this.repo.name} · ${this.repo.on}` : this.repo.name;
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

  assigneeBadges(assignees, t) {
    return h_flex().flex_none().gap(2).children(assignees.slice(0, 3).map((a) =>
      div().w(18).h(18).flex().items_center().justify_center().rounded_full().text_size(9).font_semibold()
        .bg(a.login === this.viewer ? t.accent : t.raised)
        .text_color(a.login === this.viewer ? t.accent_foreground : t.muted)
        .child(initialsOf(a.login))))
      .when(assignees.length > 3, (el) => el.child(div().text_size(10).text_color(t.dim).child(`+${assignees.length - 3}`)));
  }

  issueRow(issue, t) {
    const session = this.sessions.get(issue.number);
    const pr = session ? this.pullRequests.get(session.branch) : null;
    const summary = pr ? checksSummary(checkSteps(pr)) : "none";
    const isExpanded = this.expanded === issue.number;
    const assignees = issue.assignees ?? [];
    return v_flex().flex_none().rounded(7).when(isExpanded, (el) => el.bg(t.selected))
      .child(h_flex().id(`issue-${issue.number}`).h(30).px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.expanded = isExpanded ? null : issue.number; cx.notify(); })
        .child(svg(`${ICONS}/issue.svg`).size(14).flex_none().text_color(t.ansi2))
        .child(div().w(40).flex_none().text_size(11).text_color(t.dim).child(`#${issue.number}`))
        .child(div().flex_1().min_w(0).truncate().child(issue.title))
        .when(Boolean(session), (el) => el.child(div().flex_none().px(5).py(1).rounded(4).text_size(10)
          .bg(t.raised).text_color(t.muted).child("session")))
        .when(Boolean(pr), (el) => {
          const look = pullRequestLook(pr, t);
          return el.child(h_flex().flex_none().gap(3).items_center().text_size(11)
            .child(svg(look.icon).size(13).text_color(look.color))
            .child(div().text_color(this.outcomeColor(summary, t)).child(`#${pr.number} ${OUTCOME_GLYPH[summary]}`)));
        })
        .when(assignees.length > 0, (el) => el.child(this.assigneeBadges(assignees, t))))
      .when(isExpanded, (el) => el.child(this.issueDetails(issue, session, pr, t)));
  }

  issueDetails(issue, session, pr, t) {
    const isLaunching = this.launching === issue.number;
    const isAssigning = this.assigning === issue.number;
    const isMine = this.isAssignedToViewer(issue);
    const assignees = issue.assignees ?? [];
    return v_flex().px(8).pb(8).gap(8)
      .when(issue.labels?.length > 0, (el) => el.child(h_flex().gap(4).flex_wrap().children(issue.labels.map((label) =>
        div().px(7).py(1).rounded(10).text_size(10).font_semibold().bg(`#${label.color}`).text_color(readableTextOn(label.color)).child(label.name)))))
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().text_color(t.muted).child("Assignée à"))
        .child(div().flex_1().min_w(0).truncate().text_color(assignees.length ? t.foreground : t.dim)
          .child(assignees.length ? assignees.map((a) => a.login).join(", ") : "personne"))
        .when(Boolean(this.viewer), (el) => el.child(this.actionButton(`assign-${issue.number}`,
          isAssigning ? "…" : isMine ? "Me retirer" : "M'assigner", t, false,
          (cx) => { if (!isAssigning) this.toggleSelfAssigned(issue, cx); }))))
      .child(h_flex().gap(6)
        .child(session
          ? this.actionButton(`open-session-${issue.number}`, "Ouvrir la session", t, true, () => this.openSession(session))
          : this.actionButton(`launch-${issue.number}`, isLaunching ? "Création du worktree…" : "Lancer Claude", t, !isLaunching,
            (cx) => { if (!isLaunching) this.launch(issue, cx); }))
        .child(this.actionButton(`github-${issue.number}`, "Voir sur GitHub", t, false, () => openUrl(issue.url))))
      .when(Boolean(session), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(session.branch)))
      .when(Boolean(pr), (el) => el.child(this.pullRequestBlock(pr, t, `issue-${issue.number}`)))
      .when(Boolean(session) && !pr, (el) => el.child(div().text_size(11).text_color(t.dim).child("Pas encore de PR pour cette branche")));
  }

  pullRequestBlock(pr, t, scope) {
    const steps = checkSteps(pr);
    const look = pullRequestLook(pr, t);
    const stateLabel = pr.isDraft && pr.state === "OPEN" ? "brouillon" : PR_STATE_LABEL[pr.state] ?? pr.state.toLowerCase();
    return v_flex().gap(4)
      .child(h_flex().id(`pr-${scope}-${pr.number}`).gap(6).items_center().cursor_pointer().on_click(() => openUrl(pr.url))
        .child(svg(look.icon).size(14).flex_none().text_color(look.color))
        .child(div().flex_none().text_size(11).text_color(t.accent).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        .child(div().flex_none().px(5).py(1).rounded(4).text_size(10).bg(t.raised).text_color(look.color).child(stateLabel)))
      .when(!steps.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("Aucun check")))
      .children(steps.map((step, index) =>
        h_flex().id(`check-${scope}-${pr.number}-${index}`).h(22).px(4).gap(6).items_center().rounded(5).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click(() => openUrl(step.url))
          .child(step.outcome === "pending"
            ? div().w(12).flex_none().text_color(t.working).frames(["◐", "◓", "◑", "◒"], 160)
            : div().w(12).flex_none().text_color(this.outcomeColor(step.outcome, t)).child(OUTCOME_GLYPH[step.outcome]))
          .child(div().flex_1().min_w(0).truncate().text_size(12).child(step.name))));
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
