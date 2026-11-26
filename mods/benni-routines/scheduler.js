import { div } from "gpui-kit";
import { notify, openOverlay, closeOverlay, nextCommand, checking, layout, settings, shared, setShared } from "herdr";
import { readStore, updateStore, newId } from "./store.js";
import { parseCron, scheduleCron, cronMatches, occurrencesBetween, minuteKey, startOfMinute } from "./schedule.js";
import { startRun, followRunningRuns, purgeOldRuns } from "./runs.js";

const TICK_MS = 15000;
const FOLLOW_MS = 3000;
const MAX_MISSED_COUNTED = 10000;
// The toast's click names the run it wants through this key: a mod command can't carry arguments.
export const RUN_TO_SHOW_KEY = "benni.routines.show";

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The work column (tab bar and body) in window pixels: everything right of the sidebar. */
export function workColumnBounds() {
  const zoom = Number(settings().zoom) || 1;
  const sidebar = findNode(layout(), "sidebar");
  const left = (sidebar && !sidebar.hidden ? sidebar.size?.px ?? 268 : 0) * zoom;
  const viewport = globalThis.window.viewport_size();
  return { x: left, y: 0, width: viewport.width - left, height: viewport.height, zoom, viewport };
}

/**
 * Lives in an invisible floating block of the benni layout, so it runs while Herdr shows that layout:
 * starts routines on their minute, records the minutes missed while Herdr was closed, follows the
 * running runs, and opens the Routines screen.
 */
export class RoutineScheduler {
  init(cx) {
    this.screen = null;
    this.ticking = false;
    this.following = false;
    if (checking()) return;
    this.recordMissedRuns();
    this.tick(cx);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.timer.every(FOLLOW_MS, (cx) => {
      if (readStore().runs.some((r) => r.status === "running")) this.follow(cx);
    });
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "open") this.openScreen(null);
        else if (command === "open-run") this.openScreen(shared(RUN_TO_SHOW_KEY) ?? null);
      }
    });
  }

  // Minutes due while Herdr was closed are skipped, not caught up: one "manquée" entry per routine.
  recordMissedRuns() {
    const { lastTick, routines } = readStore();
    if (lastTick === null) return;
    const from = new Date(startOfMinute(lastTick));
    const to = new Date(startOfMinute(Date.now()));
    for (const routine of routines.filter((r) => r.enabled)) {
      let missed;
      try { missed = occurrencesBetween(parseCron(scheduleCron(routine.schedule)), from, to, MAX_MISSED_COUNTED); } catch { continue; }
      if (!missed.length) continue;
      const last = missed[missed.length - 1].getTime();
      updateStore((store) => {
        store.runs.unshift({
          id: newId("ru"), routine: routine.id, routineName: routine.name, status: "missed", startedAt: last, endedAt: null,
          print: Boolean(routine.print), tabName: null, tab: null, terminal: null, sessionId: null, worktree: null,
          summary: "", error: "", missed: missed.length, sawWorking: false, manual: false,
        });
      });
      purgeOldRuns(routine).catch(() => {});
    }
  }

  tick(cx) {
    if (this.ticking) return;
    this.ticking = true;
    const now = new Date();
    const key = minuteKey(now);
    const due = [];
    updateStore((store) => {
      for (const routine of store.routines) {
        if (!routine.enabled || routine.lastFired === key) continue;
        let cron;
        try { cron = parseCron(scheduleCron(routine.schedule)); } catch { continue; }
        if (!cronMatches(cron, now)) continue;
        routine.lastFired = key;
        due.push({ ...routine });
      }
      store.lastTick = now.getTime();
    });
    cx.spawn(async (cx) => {
      try {
        for (const routine of due) await this.launch(routine, { manual: false });
        await this.follow(cx);
      } finally {
        this.ticking = false;
      }
    });
  }

  async launch(routine, options) {
    await startRun(routine, options);
    await purgeOldRuns(routine).catch((error) => console.log(`benni-routines: purge: ${error?.message ?? error}`));
  }

  async follow(_cx) {
    if (this.following) return;
    this.following = true;
    try {
      const finished = await followRunningRuns();
      const { routines } = readStore();
      for (const record of finished) {
        const routine = routines.find((r) => r.id === record.routine);
        if (routine?.toast) this.toastFinished(record);
      }
    } catch (error) {
      console.log(`benni-routines: suivi : ${error?.message ?? error}`);
    } finally {
      this.following = false;
    }
  }

  toastFinished(record) {
    const failed = record.status === "failed";
    const firstLine = (record.summary || record.error || "").split("\n").find((l) => l.trim()) ?? "";
    setShared(RUN_TO_SHOW_KEY, record.id);
    notify({
      title: failed ? `Routine « ${record.routineName} » en échec` : `Routine « ${record.routineName} » terminée`,
      body: firstLine.slice(0, 200),
      level: failed ? "error" : "success",
      action: { name: "benni-routines.open-run" },
    });
  }

  /** The screen covers the whole work column (tab bar and body); the sidebar stays visible. */
  openScreen(runId) {
    if (this.screen) closeOverlay(this.screen);
    const area = workColumnBounds();
    this.screen = openOverlay({
      mod: "benni-routines",
      kind: "window",
      frame: "none",
      // One screen at a time, even across a reload of this mod that forgot `this.screen`.
      key: "benni-routines-screen",
      props: { role: "screen", runId, viewport: area.viewport, x: area.x },
      at: { x: Math.round(area.x), y: 0 },
      width: Math.round(area.width / area.zoom),
      height: Math.round(area.height / area.zoom),
    });
  }

  render() {
    return div();
  }
}
