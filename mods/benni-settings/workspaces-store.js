// Each machine's workspaces, kept in its own benni/workspaces.json. Repeated verbatim in benni-spaces
// and benni-settings (Herdr refuses imports between mods): change both together.
//
// File:  { enabled, list: [{ id, name }], of: { spaceId: workspaceId } }, space ids as that machine names them.
// Cache: shared("benni.machines.workspaces") = { [machineKey]: { enabled, list, of, state, error } }, with this
//        app's ids (`machine/` prefix), the last copy read: every mod draws from it, and an offline machine
//        keeps its last known workspaces. Writes never start from it: they read the file again.

import { shared, setShared, checking } from "herdr";
import { machineKey, appId, bareId, readMachineFiles, changeMachineJson } from "./machine-files.js";

export const WORKSPACES_CACHE_KEY = "benni.machines.workspaces";
// What the layout used before workspaces were per machine: read once, to start each machine's file.
const LEGACY_WORKSPACES_KEY = "benni.workspaces";
const WORKSPACES_FILE = "benni/workspaces.json";
export const DEFAULT_WORKSPACE = { id: "default", name: "Default" };

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function normalizeWorkspaces(stored) {
  const value = isPlainObject(stored) ? stored : {};
  const list = Array.isArray(value.list) ? value.list.filter((w) => w?.id && typeof w.name === "string").map((w) => ({ id: w.id, name: w.name })) : [];
  if (!list.some((w) => w.id === DEFAULT_WORKSPACE.id)) list.unshift({ ...DEFAULT_WORKSPACE });
  const of = isPlainObject(value.of) ? { ...value.of } : {};
  return { enabled: value.enabled === true, list, of };
}

const translateOf = (of, translate) => Object.fromEntries(Object.entries(of).map(([space, ws]) => [translate(space), ws]));
const toFile = (machine, store) => ({ ...store, of: translateOf(store.of, (id) => bareId(machine, id)) });
const fromFile = (machine, store) => ({ ...store, of: translateOf(store.of, (id) => appId(machine, id)) });
// A machine's own spaces have bare ids; prefixed ones there belong to machines it reaches.
const ownSpacesOnly = (store) => ({ ...store, of: Object.fromEntries(Object.entries(store.of).filter(([space]) => !space.includes("/"))) });

/** A machine's workspaces as last read, app ids. */
export function readWorkspaces(machine) {
  return normalizeWorkspaces((shared(WORKSPACES_CACHE_KEY) ?? {})[machineKey(machine)]);
}

/** "ready" (read this session or earlier), "offline" (the last read failed), or "unknown" (never read). */
export function workspacesState(machine) {
  const entry = (shared(WORKSPACES_CACHE_KEY) ?? {})[machineKey(machine)];
  return { state: entry?.state ?? "unknown", error: entry?.error ?? "" };
}

export function workspaceOfSpace(store, spaceId) {
  const id = store.of[spaceId];
  return store.list.some((w) => w.id === id) ? id : DEFAULT_WORKSPACE.id;
}

// everRead: some copy was read once, so a failed read can say "last known copy" rather than defaults.
function publish(machine, store, state, error = "") {
  const cache = { ...(shared(WORKSPACES_CACHE_KEY) ?? {}) };
  const everRead = state === "ready" || Boolean(cache[machineKey(machine)]?.everRead);
  const entry = { ...store, state, error, everRead };
  if (JSON.stringify(cache[machineKey(machine)]) === JSON.stringify(entry)) return;
  cache[machineKey(machine)] = entry;
  setShared(WORKSPACES_CACHE_KEY, cache);
}

function markOffline(machine, error) {
  const known = (shared(WORKSPACES_CACHE_KEY) ?? {})[machineKey(machine)];
  publish(machine, normalizeWorkspaces(known), known?.everRead ? "offline" : "unknown", String(error?.message ?? error));
}

// A machine without its file starts from its own Herdr's workspaces (its shared.json, read only),
// else from what this computer recorded for that machine's spaces.
async function startingWorkspaces(machine) {
  if (!machine) return toFile(null, ownSpacesOnly(normalizeWorkspaces(shared(LEGACY_WORKSPACES_KEY))));
  const sharedText = (await readMachineFiles(machine, ["shared.json"]))["shared.json"];
  if (sharedText !== null) {
    let theirs;
    try { theirs = JSON.parse(sharedText); } catch { throw new Error(`shared.json illisible sur ${machine}`); }
    if (isPlainObject(theirs) && LEGACY_WORKSPACES_KEY in theirs) return ownSpacesOnly(normalizeWorkspaces(theirs[LEGACY_WORKSPACES_KEY]));
  }
  const mine = normalizeWorkspaces(shared(LEGACY_WORKSPACES_KEY));
  const prefix = `${machine}/`;
  const of = {};
  for (const [space, ws] of Object.entries(mine.of)) if (space.startsWith(prefix)) of[space.slice(prefix.length)] = ws;
  const used = new Set(Object.values(of));
  const list = [{ ...DEFAULT_WORKSPACE }, ...mine.list.filter((w) => w.id !== DEFAULT_WORKSPACE.id && used.has(w.id))];
  return { enabled: mine.enabled && list.length > 1, list, of };
}

/** Reads a machine's file (making it from its old settings the first time) and publishes it. */
export async function syncWorkspaces(machine) {
  if (checking()) return;
  try {
    const text = (await readMachineFiles(machine, [WORKSPACES_FILE]))[WORKSPACES_FILE];
    let stored;
    if (text === null) stored = await changeMachineJson(machine, WORKSPACES_FILE, { initial: () => startingWorkspaces(machine), change: (data) => data });
    else {
      try { stored = JSON.parse(text); } catch { throw new Error(`${WORKSPACES_FILE} n'est pas du JSON valide`); }
    }
    publish(machine, fromFile(machine, normalizeWorkspaces(stored)), "ready");
  } catch (error) {
    markOffline(machine, error);
  }
}

/**
 * Applies `change` (on app ids) to the cache at once, then to the machine's file read fresh, and
 * publishes what was written. Throws when the machine can't be written; the cache is then read again.
 */
export async function changeWorkspaces(machine, change) {
  const optimistic = readWorkspaces(machine);
  change(optimistic);
  publish(machine, normalizeWorkspaces(optimistic), workspacesState(machine).state);
  if (checking()) return;
  try {
    const written = await changeMachineJson(machine, WORKSPACES_FILE, {
      initial: () => startingWorkspaces(machine),
      change: (data) => {
        const store = fromFile(machine, normalizeWorkspaces(data));
        change(store);
        return toFile(machine, normalizeWorkspaces(store));
      },
    });
    publish(machine, fromFile(machine, normalizeWorkspaces(written)), "ready");
  } catch (error) {
    await syncWorkspaces(machine);
    throw error;
  }
}
