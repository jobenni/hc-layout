import { div } from "gpui-kit";
import { notify, openOverlay, closeOverlay, nextCommand, checking, layout, settings, shared, setShared, machines, exec } from "herdr";
import { readStore, readAllStores, changeRuns, newId, syncStore, storeState, clockOf, readUtcOffset, publishUtcOffset } from "./store.js";
import { parseCron, scheduleCron, cronMatches, occurrencesBetween, startOfMinute } from "./schedule.js";
import { startRun, followRunningRuns, purgeOldRuns } from "./runs.js";
import { machineKey, machineOfKey, machineAppDir } from "./machine-files.js";

const TICK_MS = 15000;
const FOLLOW_MS = 3000;
// Another client may edit a machine's routines: their files are read again this often.
const SYNC_MS = 20000;
const UTC_OFFSET_MS = 3600000;
// lastTick only bounds the search for missed minutes (claims say which ran): no need to write it every tick.
const LAST_TICK_WRITE_MS = 5 * 60000;
const CLAIMS_CLEAN_MS = 3600000;
const CLAIMS_KEPT_MINUTES = 2880;
const MAX_MISSED_COUNTED = 10000;
// Checks are 15s apart: a longer silence means the minutes in between were never looked at.
const MISSED_AFTER_MS = 75000;
// The toast's click names the run it wants through this key: a mod command can't carry arguments.
// { machine: machineKey, run: runId } (a plain id, from before machines, is this computer's).
export const RUN_TO_SHOW_KEY = "benni.routines.show";

// A minute of a routine is started by whoever creates its claim folder first on the routine's machine,
// so two clients connected to it never start the same minute twice.
const minuteIndex = (time) => Math.floor(time / 60000);
const runClaim = (routineId, time) => `${routineId}-${minuteIndex(time)}`;
const missedClaim = (routineId, time) => `missed-${routineId}-${minuteIndex(time)}`;
const claimsDirOn = async (machine) => `${await machineAppDir(machine)}/benni/claims`;

async function claim(machine, name) {
  const result = await exec("sh", ["-c", 'mkdir -p "$1" && mkdir "$1/$2" 2>/dev/null', "sh", await claimsDirOn(machine), name], { on: machine });
  return result.code === 0;
}

async function listClaims(machine) {
  const result = await exec("sh", ["-c", 'mkdir -p "$1" && ls "$1"', "sh", await claimsDirOn(machine)], { on: machine });
  if (result.code !== 0) throw new Error("claims illisibles");
  return new Set(result.stdout.split("\n").filter(Boolean));
}

async function cleanClaims(machine) {
  const dir = await claimsDirOn(machine);
  await exec("find", [dir, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-mmin", `+${CLAIMS_KEPT_MINUTES}`, "-exec", "rmdir", "{}", "+"], { on: machine });
}

export function runToShow() {
  const target = shared(RUN_TO_SHOW_KEY);
  if (typeof target === "string") return { machine: null, run: target };
  return target && typeof target === "object" ? { machine: machineOfKey(target.machine ?? ""), run: target.run } : null;
}

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
 * for each machine it can reach, reads its routines, starts them on their minute (in that machine's
 * time), records the minutes missed while nothing ran, follows the running runs, and opens the screen.
 */
export class RoutineScheduler {
  init(cx) {
    this.screen = null;
    this.machineStates = new Map(); // machineKey -> what this client knows of that machine's scheduling
    if (checking()) return;
    this.syncAll(cx);
    cx.timer.every(SYNC_MS, (cx) => this.syncAll(cx));
    cx.timer.every(1000, (cx) => this.syncReturningMachines(cx));
    cx.timer.every(TICK_MS, (cx) => { for (const machine of this.knownMachines()) this.tick(machine, cx); });
    cx.timer.every(FOLLOW_MS, (cx) => {
      for (const [machine, store] of readAllStores()) if (store.runs.some((r) => r.status === "running")) this.follow(machine, cx);
    });
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "open") this.openScreen(null);
        else if (command === "open-run") this.openScreen(runToShow());
      }
    });
  }

  stateOf(machine) {
    const key = machineKey(machine);
    if (!this.machineStates.has(key)) {
      this.machineStates.set(key, { ticking: false, following: false, syncing: false, ready: null, lastSeen: null, lastTickWrittenAt: 0, offsetReadAt: 0, cleanedAt: 0, fired: new Map() });
    }
    return this.machineStates.get(key);
  }

  knownMachines() {
    const names = new Set([...machines().map((m) => m.name).filter(Boolean), ...readAllStores().map(([machine]) => machine).filter(Boolean)]);
    return [null, ...[...names].sort()];
  }

  syncAll(cx) {
    for (const machine of this.knownMachines()) this.sync(machine, cx);
  }

  // A machine that comes back is read at once.
  syncReturningMachines(cx) {
    for (const m of machines()) {
      const state = this.stateOf(m.name);
      const ready = m.layout === "ready";
      if (ready && state.ready === false) this.sync(m.name, cx);
      state.ready = ready;
    }
  }

  sync(machine, cx) {
    const state = this.stateOf(machine);
    if (state.syncing) return;
    state.syncing = true;
    cx.spawn(async () => {
      try {
        await syncStore(machine);
        if (machine && Date.now() - state.offsetReadAt > UTC_OFFSET_MS && storeState(machine).state === "ready") {
          const offset = await readUtcOffset(machine).catch(() => null);
          if (offset !== null) { publishUtcOffset(machine, offset); state.offsetReadAt = Date.now(); }
        }
      } finally {
        state.syncing = false;
      }
    });
  }

  // Its files read, connected, and (another machine) its time zone known.
  canRun(machine) {
    if (storeState(machine).state !== "ready") return false;
    if (!machine) return true;
    return machines().find((m) => m.name === machine)?.layout === "ready" && clockOf(machine) !== null;
  }

  // Minutes due while nothing checked (Herdr closed, the Mac asleep) are skipped, not caught up: one "Manqué"
  // entry per routine with their count, leaving out minutes some client did start (their claim exists).
  async recordMissedRuns(machine, lastTick, now, machineClock) {
    const claims = await listClaims(machine);
    const to = machineClock.toWall(startOfMinute(now));
    for (const routine of readStore(machine).routines.filter((r) => r.enabled)) {
      // Nothing is missed before the routine was last turned on or saved.
      const from = machineClock.toWall(startOfMinute(Math.max(lastTick, routine.armedAt ?? 0)));
      let missed;
      try { missed = occurrencesBetween(parseCron(scheduleCron(routine.schedule)), from, to, MAX_MISSED_COUNTED); } catch { continue; }
      const times = missed.map((wall) => machineClock.toTime(wall)).filter((time) => !claims.has(runClaim(routine.id, time)));
      if (!times.length) continue;
      const last = times[times.length - 1];
      if (!(await claim(machine, missedClaim(routine.id, last)))) continue;
      await changeRuns(machine, (data) => {
        data.runs.unshift({
          id: newId("ru"), routine: routine.id, routineName: routine.name, status: "missed", startedAt: last, endedAt: null,
          print: Boolean(routine.print), tabName: null, tab: null, terminal: null, sessionId: null, worktree: null,
          summary: "", error: "", missed: times.length, sawWorking: false, manual: false,
        });
      });
      await purgeOldRuns(machine, routine).catch(() => {});
    }
  }

  tick(machine, cx) {
    const state = this.stateOf(machine);
    if (state.ticking || !this.canRun(machine)) return;
    state.ticking = true;
    cx.spawn(async (cx) => {
      try {
        const now = Date.now();
        const machineClock = clockOf(machine);
        const store = readStore(machine);
        const previous = state.lastSeen ?? store.lastTick;
        state.lastSeen = now;
        if (previous !== null && now - previous > MISSED_AFTER_MS) await this.recordMissedRuns(machine, previous, now, machineClock).catch((error) => console.log(`benni-routines: manqués sur ${machine ?? "cet ordinateur"} : ${error?.message ?? error}`));
        const minute = startOfMinute(now);
        const wall = machineClock.toWall(now);
        for (const routine of store.routines) {
          if (!routine.enabled || routine.armedAt === minute || state.fired.get(routine.id) === minute) continue;
          let cron;
          try { cron = parseCron(scheduleCron(routine.schedule)); } catch { continue; }
          if (!cronMatches(cron, wall)) continue;
          state.fired.set(routine.id, minute);
          try {
            if (await claim(machine, runClaim(routine.id, now))) await this.launch(machine, routine);
          } catch (error) {
            console.log(`benni-routines: ${routine.name} : ${error?.message ?? error}`);
          }
        }
        if (now - state.lastTickWrittenAt > LAST_TICK_WRITE_MS) {
          state.lastTickWrittenAt = now;
          await changeRuns(machine, (data) => { data.lastTick = now; });
        }
        if (now - state.cleanedAt > CLAIMS_CLEAN_MS) {
          state.cleanedAt = now;
          await cleanClaims(machine).catch(() => {});
        }
        await this.follow(machine, cx);
      } catch (error) {
        console.log(`benni-routines: planification sur ${machine ?? "cet ordinateur"} : ${error?.message ?? error}`);
      } finally {
        state.ticking = false;
      }
    });
  }

  async launch(machine, routine) {
    await startRun(machine, routine, { manual: false });
    await purgeOldRuns(machine, routine).catch((error) => console.log(`benni-routines: purge: ${error?.message ?? error}`));
  }

  async follow(machine, _cx) {
    const state = this.stateOf(machine);
    if (state.following) return;
    state.following = true;
    try {
      const finished = await followRunningRuns(machine);
      const { routines } = readStore(machine);
      for (const record of finished) {
        const routine = routines.find((r) => r.id === record.routine);
        if (routine?.toast) this.toastFinished(machine, record);
      }
    } catch (error) {
      console.log(`benni-routines: suivi : ${error?.message ?? error}`);
    } finally {
      state.following = false;
    }
  }

  toastFinished(machine, record) {
    const failed = record.status === "failed";
    const firstLine = (record.summary || record.error || "").split("\n").find((l) => l.trim()) ?? "";
    setShared(RUN_TO_SHOW_KEY, { machine: machineKey(machine), run: record.id });
    notify({
      title: failed ? `Routine « ${record.routineName} » en échec` : `Routine « ${record.routineName} » terminée`,
      body: `${machine ? `${machine} · ` : ""}${firstLine}`.slice(0, 200),
      level: failed ? "error" : "success",
      action: { name: "benni-routines.open-run" },
    });
  }

  /** The screen covers the whole work column (tab bar and body); the sidebar stays visible. */
  openScreen(target) {
    if (this.screen) closeOverlay(this.screen);
    const area = workColumnBounds();
    this.screen = openOverlay({
      mod: "benni-routines",
      kind: "window",
      frame: "none",
      // One screen at a time, even across a reload of this mod that forgot `this.screen`.
      key: "benni-routines-screen",
      props: { role: "screen", target, viewport: area.viewport, x: area.x },
      at: { x: Math.round(area.x), y: 0 },
      width: Math.round(area.width / area.zoom),
      height: Math.round(area.height / area.zoom),
    });
  }

  render() {
    return div();
  }
}
