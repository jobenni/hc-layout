import { shared, setShared, checking, exec } from "herdr";
import { machineKey, machineOfKey, appId, bareId, readMachineFiles, changeMachineJson, jsonText } from "./machine-files.js";
import { localClock, offsetClock, parseUtcOffset } from "./schedule.js";

// Each machine keeps its routines in its own Herdr app folder (see machine-files.js):
//   benni/routines.json  { routines: Routine[] }                           edited by hand, rarely
//   benni/runs.json      { runs: Run[], lastTick, spaceId }                written by the scheduler
// with ids as that machine names them. The last copy read of every machine is published in
// shared("benni.machines.routines") = { [machineKey]: { routines, runs, lastTick, spaceId, utcOffset,
// state, error } } with this app's ids (`machine/` prefix), which every mod draws from. Writes read the
// files again first: the cache is never written back as is.
export const ROUTINES_CACHE_KEY = "benni.machines.routines";
// What the layout used before routines were per machine: read once, to start this computer's files.
const LEGACY_KEY = "benni.routines";
const ROUTINES_FILE = "benni/routines.json";
const RUNS_FILE = "benni/runs.json";
// readTextFile reads at most 1 MiB: past this, the oldest finished runs go.
const RUNS_FILE_MAX_CHARS = 800 * 1024;
export const ROUTINES_SPACE_NAME = "Routines";
export const DEFAULT_KEPT_RUNS = 20;

export const MODELS = [
  { id: "haiku", label: "Haiku" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "fable", label: "Fable" },
];
// From `claude --help` (2.1.332): --effort low|medium|high|xhigh|max. "" leaves the flag out.
export const EFFORTS = [
  { id: "", label: "Défaut" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
  { id: "max", label: "max" },
];

/**
 * @typedef {{kind: "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "cron", every: number, minute: number,
 *   times: string[], time: string, weekday: number, cron: string}} Schedule
 *   times: "HH:MM" of daily, weekdays and weekly; time: their first, all a schedule had before times.
 * @typedef {{id: string, name: string, description: string, prompt: string, schedule: Schedule, folder: string,
 *   worktree: boolean, model: string, effort: string, print: boolean, enabled: boolean, keep: number,
 *   toast: boolean, push: boolean, armedAt: number | null}} Routine
 *   armedAt: the minute (ms) it was last turned on or saved, which it doesn't run late.
 * @typedef {{path: string, branch: string, main: string}} RunWorktree
 * @typedef {{id: string, routine: string, routineName: string, status: "running" | "done" | "failed" | "missed",
 *   startedAt: number, endedAt: number | null, print: boolean, tabName: string | null, tab: string | null,
 *   terminal: string | null, sessionId: string | null, worktree: RunWorktree | null, summary: string,
 *   error: string, missed: number, sawWorking: boolean, manual: boolean}} Run
 */

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function normalizeRoutines(stored) {
  const routines = Array.isArray(stored?.routines) ? stored.routines.filter(isPlainObject) : [];
  return { routines: routines.map(({ lastFired: _dropped, ...routine }) => routine) };
}

function normalizeRuns(stored) {
  return {
    runs: Array.isArray(stored?.runs) ? stored.runs.filter(isPlainObject) : [],
    lastTick: typeof stored?.lastTick === "number" ? stored.lastTick : null,
    spaceId: typeof stored?.spaceId === "string" ? stored.spaceId : null,
  };
}

const translateRun = (run, translate) => ({ ...run, tab: translate(run.tab), terminal: translate(run.terminal) });
const runsFromFile = (machine, data) => {
  const runs = normalizeRuns(data);
  return { ...runs, runs: runs.runs.map((r) => translateRun(r, (id) => appId(machine, id))), spaceId: appId(machine, runs.spaceId) };
};
const runsToFile = (machine, data) => {
  const runs = normalizeRuns(data);
  return { ...runs, runs: runs.runs.map((r) => translateRun(r, (id) => bareId(machine, id))), spaceId: bareId(machine, runs.spaceId) };
};

// Oldest finished runs go first, so the file stays readable.
function keepUnderReadLimit(runsData) {
  const runs = [...runsData.runs];
  while (jsonText({ ...runsData, runs }).length > RUNS_FILE_MAX_CHARS) {
    let oldest = -1;
    for (const [index, run] of runs.entries()) if (run.status !== "running" && (oldest < 0 || run.startedAt < runs[oldest].startedAt)) oldest = index;
    if (oldest < 0) break;
    runs.splice(oldest, 1);
  }
  return { ...runsData, runs };
}

function cacheEntry(machine) {
  return (shared(ROUTINES_CACHE_KEY) ?? {})[machineKey(machine)] ?? null;
}

/** A machine's routines and runs as last read, app ids. */
export function readStore(machine) {
  const entry = cacheEntry(machine);
  return { ...normalizeRoutines(entry), ...normalizeRuns(entry) };
}

/** Every machine whose routines were read, as [machine, store]. */
export function readAllStores() {
  return Object.keys(shared(ROUTINES_CACHE_KEY) ?? {}).map((key) => [machineOfKey(key), readStore(machineOfKey(key))]);
}

/** "ready", "offline" (the last read failed: what shows is the last copy) or "unknown" (never read). */
export function storeState(machine) {
  const entry = cacheEntry(machine);
  return { state: entry?.state ?? "unknown", error: entry?.error ?? "" };
}

/** The clock a machine's schedules are read in: this computer's, or the other machine's UTC offset (null until known). */
export function clockOf(machine) {
  if (!machine) return localClock;
  const offset = cacheEntry(machine)?.utcOffset;
  return typeof offset === "number" ? offsetClock(offset) : null;
}

function publish(machine, change) {
  const cache = { ...(shared(ROUTINES_CACHE_KEY) ?? {}) };
  const key = machineKey(machine);
  const entry = { ...(cache[key] ?? { ...normalizeRoutines(null), ...normalizeRuns(null), state: "unknown", error: "" }), ...change };
  if (JSON.stringify(cache[key]) === JSON.stringify(entry)) return;
  cache[key] = entry;
  setShared(ROUTINES_CACHE_KEY, cache);
}

export function publishUtcOffset(machine, utcOffset) {
  publish(machine, { utcOffset });
}

// A machine without its files starts from its own Herdr's routines (this computer: shared("benni.routines");
// another: its shared.json, read only), else empty.
async function legacyRoutines(machine) {
  if (!machine) return shared(LEGACY_KEY) ?? null;
  const text = (await readMachineFiles(machine, ["shared.json"]))["shared.json"];
  if (text === null) return null;
  let theirs;
  try { theirs = JSON.parse(text); } catch { throw new Error(`shared.json illisible sur ${machine}`); }
  return isPlainObject(theirs?.[LEGACY_KEY]) ? theirs[LEGACY_KEY] : null;
}

/** Reads a machine's two files (making them from its old settings the first time) and publishes them. */
export async function syncStore(machine) {
  if (checking()) return;
  try {
    const texts = await readMachineFiles(machine, [ROUTINES_FILE, RUNS_FILE]);
    const parse = (name) => {
      try { return JSON.parse(texts[name]); } catch { throw new Error(`${name} n'est pas du JSON valide`); }
    };
    const legacy = texts[ROUTINES_FILE] === null || texts[RUNS_FILE] === null ? await legacyRoutines(machine) : null;
    const routines = texts[ROUTINES_FILE] === null
      ? await changeMachineJson(machine, ROUTINES_FILE, { initial: () => normalizeRoutines(legacy), change: (data) => data })
      : parse(ROUTINES_FILE);
    const runs = texts[RUNS_FILE] === null
      ? await changeMachineJson(machine, RUNS_FILE, { initial: () => keepUnderReadLimit(normalizeRuns(legacy)), change: (data) => data })
      : parse(RUNS_FILE);
    publish(machine, { ...normalizeRoutines(routines), ...runsFromFile(machine, runs), state: "ready", error: "", everRead: true });
  } catch (error) {
    publish(machine, { state: cacheEntry(machine)?.everRead ? "offline" : "unknown", error: String(error?.message ?? error) });
  }
}

// The change shows at once; then it is replayed on the file read fresh, and what was written is published.
async function changeFile(machine, name, { initial, fromFile, toFile, normalize, cached, change }) {
  const optimistic = cached();
  change(optimistic);
  publish(machine, normalize(optimistic));
  if (checking()) return;
  try {
    const written = await changeMachineJson(machine, name, {
      initial,
      change: (data) => {
        const value = fromFile(data);
        change(value);
        return toFile(normalize(value));
      },
    });
    publish(machine, { ...fromFile(written), state: "ready", error: "", everRead: true });
  } catch (error) {
    await syncStore(machine);
    throw error;
  }
}

/** Edits a machine's routine definitions: `change({ routines })` in place. */
export function changeRoutines(machine, change) {
  return changeFile(machine, ROUTINES_FILE, {
    initial: async () => normalizeRoutines(await legacyRoutines(machine)),
    fromFile: (data) => normalizeRoutines(data),
    toFile: (value) => normalizeRoutines(value),
    normalize: normalizeRoutines,
    cached: () => normalizeRoutines(readStore(machine)),
    change,
  });
}

/** Edits a machine's runs: `change({ runs, lastTick, spaceId })` in place, app ids. */
export function changeRuns(machine, change) {
  return changeFile(machine, RUNS_FILE, {
    initial: async () => keepUnderReadLimit(normalizeRuns(await legacyRoutines(machine))),
    fromFile: (data) => runsFromFile(machine, data),
    toFile: (value) => keepUnderReadLimit(runsToFile(machine, value)),
    normalize: normalizeRuns,
    cached: () => normalizeRuns(readStore(machine)),
    change,
  });
}

/** Changes one run if it is still there; `change(run, runsData)`. */
export function updateRun(machine, runId, change) {
  return changeRuns(machine, (data) => {
    const run = data.runs.find((r) => r.id === runId);
    if (run) change(run, data);
  });
}

/** Reads the machine's UTC offset in minutes ("+0100" -> 60), or null. */
export async function readUtcOffset(machine) {
  const result = await exec("date", ["+%z"], { on: machine, timeout: 15000 });
  return result.code === 0 ? parseUtcOffset(result.stdout) : null;
}

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;
}

/** @returns {Routine} */
export function blankRoutine() {
  return {
    id: newId("rt"),
    name: "",
    description: "",
    prompt: "",
    schedule: { kind: "daily", every: 30, minute: 0, times: ["09:00"], time: "09:00", weekday: 1, cron: "0 9 * * *" },
    folder: "",
    worktree: false,
    model: "sonnet",
    effort: "",
    print: false,
    enabled: true,
    keep: DEFAULT_KEPT_RUNS,
    toast: true,
    push: false,
    armedAt: null,
  };
}

export function slugOf(name) {
  return (name ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "routine";
}

export function randomUuid() {
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
