import { shared, setShared } from "herdr";

// Definitions and history live in Herdr's shared.json, so they survive restarts:
// { routines: Routine[], runs: Run[], lastTick: number | null, spaceId: string | null }
const STORE_KEY = "benni.routines";
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
  { id: "", label: "Par défaut" },
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
  { id: "max", label: "max" },
];

/**
 * @typedef {{kind: "hourly" | "daily" | "weekdays" | "weekly" | "cron", minute: number, time: string, weekday: number, cron: string}} Schedule
 * @typedef {{id: string, name: string, description: string, prompt: string, schedule: Schedule, folder: string,
 *   worktree: boolean, model: string, effort: string, print: boolean, enabled: boolean, keep: number,
 *   toast: boolean, push: boolean, lastFired: string | null}} Routine
 * @typedef {{path: string, branch: string, main: string}} RunWorktree
 * @typedef {{id: string, routine: string, routineName: string, status: "running" | "done" | "failed" | "missed",
 *   startedAt: number, endedAt: number | null, print: boolean, tabName: string | null, tab: string | null,
 *   terminal: string | null, sessionId: string | null, worktree: RunWorktree | null, summary: string,
 *   error: string, missed: number, sawWorking: boolean, manual: boolean}} Run
 */

export function readStore() {
  const stored = shared(STORE_KEY);
  return {
    routines: Array.isArray(stored?.routines) ? stored.routines : [],
    runs: Array.isArray(stored?.runs) ? stored.runs : [],
    lastTick: typeof stored?.lastTick === "number" ? stored.lastTick : null,
    spaceId: typeof stored?.spaceId === "string" ? stored.spaceId : null,
  };
}

export function writeStore(store) {
  setShared(STORE_KEY, store);
}

/** Reads, lets `change` edit the store in place, writes it back. */
export function updateStore(change) {
  const store = readStore();
  change(store);
  writeStore(store);
  return store;
}

export function updateRun(runId, change) {
  return updateStore((store) => {
    const run = store.runs.find((r) => r.id === runId);
    if (run) change(run, store);
  });
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
    schedule: { kind: "daily", minute: 0, time: "09:00", weekday: 1, cron: "0 9 * * *" },
    folder: "",
    worktree: false,
    model: "sonnet",
    effort: "",
    print: false,
    enabled: true,
    keep: DEFAULT_KEPT_RUNS,
    toast: true,
    push: false,
    lastFired: null,
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
