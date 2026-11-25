import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, focused, layout, theme, settings, openOverlay, closeOverlay, nextCommand, checking, window as appWindow } from "herdr";
import { readClaudeTerminal, readRuns, readSteps, isRunInProgress } from "./workflow-files.js";

const POLL_EVERY_MS = 4000;

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function pxOf(node, fallback) {
  return node?.size?.px ?? fallback;
}

/** The tab area (`main`) in window pixels, from the layout's sizes (at zoom 1) and the window's. */
function tabAreaBounds() {
  const root = layout();
  const zoom = Number(settings().zoom) || 1;
  const sidebar = findNode(root, "sidebar");
  const workBody = findNode(root, "work-body");
  const panel = findNode(root, "panel");
  const padding = workBody?.padding ?? 8;
  const gap = workBody?.gap ?? 8;
  const left = (sidebar && !sidebar.hidden ? pxOf(sidebar, 268) : 0) + padding;
  const top = pxOf(findNode(root, "tabs"), 42) + padding;
  const right = padding + (panel && !panel.hidden ? pxOf(panel, 368) + gap : 0);
  const viewport = globalThis.window.viewport_size();
  return {
    x: left * zoom,
    y: top * zoom,
    width: viewport.width - (left + right) * zoom,
    height: viewport.height - (top + padding) * zoom,
  };
}

function claudePaneToWatch() {
  const tab = focused()?.tab;
  const claudePanes = panes().filter((p) => p.tab === tab && p.terminal && p.app === "claude-code");
  return claudePanes.find((p) => p.focused) ?? claudePanes[0] ?? null;
}

export class WorkflowButton {
  init(cx) {
    this.watched = null;
    this.viewerOverlay = null;
    this.shown = null;
    this.reading = false;
    cx.timer.every(POLL_EVERY_MS, (cx) => {
      if (appWindow()?.visible !== false) this.refresh(cx);
    });
    this.refresh(cx);
    cx.spawn(async () => {
      for (;;) {
        if ((await nextCommand()) === "open" && this.shown) this.openViewer();
      }
    });
  }

  refresh(cx) {
    if (checking() || this.reading) return;
    const pane = claudePaneToWatch();
    this.watched = pane?.terminal ?? null;
    if (!pane) {
      if (this.shown) { this.shown = null; cx.notify(); }
      return;
    }
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        this.shown = await this.readRunInProgress(pane.terminal);
      } catch (error) {
        console.log(`claude-workflow: ${error.message}`);
        this.shown = null;
      } finally {
        this.reading = false;
      }
      cx.notify();
    });
  }

  async readRunInProgress(terminal) {
    const claude = await readClaudeTerminal(terminal);
    if (!claude?.pid || !claude.workingTaskIds.length) return null;
    const { runs } = await readRuns(claude.pid);
    const run = runs.find((r) => isRunInProgress(r, claude.workingTaskIds));
    if (!run) return null;
    const { steps } = await readSteps(run.dir);
    const finished = steps.filter((s) => s.state !== "running").length;
    return { terminal, pid: claude.pid, run, finished, started: steps.length };
  }

  openViewer() {
    const { terminal, pid, run } = this.shown;
    const area = tabAreaBounds();
    const zoom = Number(settings().zoom) || 1;
    if (this.viewerOverlay) closeOverlay(this.viewerOverlay);
    // A frameless window over the whole tab area: the viewer veils it and centers its card.
    // Not a popup: a popup is capped below the size asked for.
    this.viewerOverlay = openOverlay({
      mod: "claude-workflow",
      kind: "window",
      frame: "none",
      props: { role: "viewer", terminal, tab: focused()?.tab, pid, runId: run.runId },
      at: { x: Math.round(area.x), y: Math.round(area.y) },
      width: Math.round(area.width / zoom),
      height: Math.round(area.height / zoom),
    });
  }

  render(cx) {
    const pane = claudePaneToWatch();
    if ((pane?.terminal ?? null) !== this.watched) this.refresh(cx);
    if (!this.shown || this.shown.terminal !== pane?.terminal) return div();
    const t = theme();
    const { run, finished, started } = this.shown;
    return h_flex()
      .id("workflow-button")
      .gap(7)
      .px(10)
      .h(28)
      .items_center()
      .rounded(6)
      .text_size(12)
      .text_color(t.foreground)
      .hover((s) => s.bg(t.hover))
      .tooltip("Voir le workflow en cours")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.openViewer())
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
      .child(div().font_medium().max_w(220).truncate().child(run.name ?? "Workflow"))
      .child(div().text_color(t.dim).child(`${finished}/${started}`));
  }
}
