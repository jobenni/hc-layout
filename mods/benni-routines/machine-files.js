// A machine's own benni files, read and written on that machine. Repeated verbatim in benni-spaces,
// benni-settings and benni-routines (Herdr refuses imports between mods): change all three together.
//
// Paths are relative to the machine's Herdr app folder: appHome() here, ~/.config/herdr-app on another
// machine (which may only run herdr-core, so the folders are made on the first write).
// A read says, per file, its text or null when the file is absent; it throws when it can't tell
// (machine unreachable or still loading), so callers keep what they knew and write nothing.

import { exec, readTextFile, writeTextFile, appHome, home, machines } from "herdr";

/** shared() keys can't be null: this computer is "". */
export const machineKey = (machine) => machine ?? "";
export const machineOfKey = (key) => key || null;

/** Another machine's ids carry a `machine/` prefix in this app and none in its own files. */
export const appId = (machine, id) => (machine && typeof id === "string" && id && !id.startsWith(`${machine}/`) ? `${machine}/${id}` : id);
export const bareId = (machine, id) => (machine && typeof id === "string" && id.startsWith(`${machine}/`) ? id.slice(machine.length + 1) : id);

const REMOTE_APP_DIR = ".config/herdr-app";
const PROBE_TIMEOUT_MS = 15000;
const WRITE_TIMEOUT_MS = 30000;
const MAX_WRITE_ATTEMPTS = 5;

// One exec that proves the machine answers, says where its app folder is and which files exist.
const PROBE = [
  `dir="$HOME/${REMOTE_APP_DIR}"`,
  'printf "%s\\n" "$dir"',
  'for f; do if [ -f "$dir/$f" ]; then echo 1; else echo 0; fi; done',
].join("\n");

// Runs on the machine, the new text on stdin: replaces the file only if it is still the one read
// (its cksum, or "absent"), under a mkdir lock so two clients can't both win. Exit 9: it changed.
const REPLACE_IF_UNCHANGED = [
  `file="$HOME/${REMOTE_APP_DIR}/$1"`,
  "expected=$2",
  'mkdir -p "$(dirname "$file")" || exit 3',
  'incoming="$file.incoming.$$"',
  'cat > "$incoming" || { rm -f "$incoming"; exit 3; }',
  'lock="$file.lock"',
  "tries=0",
  'until mkdir "$lock" 2>/dev/null; do',
  "  tries=$((tries + 1))",
  '  if [ "$tries" -gt 50 ]; then rmdir "$lock" 2>/dev/null; tries=0; fi',
  "  sleep 0.1",
  "done",
  "current=absent",
  '[ -f "$file" ] && current=$(cksum < "$file")',
  'if [ "$current" != "$expected" ]; then rm -f "$incoming"; rmdir "$lock"; exit 9; fi',
  'mv "$incoming" "$file"',
  "status=$?",
  'rmdir "$lock"',
  "exit $status",
].join("\n");

// Here: the expected text's cksum, then the new text piped to the machine (an argument would cap
// out near 128 KiB on Linux; hc() has no stdin).
const SEND_TO_MACHINE = [
  'machine=$1 name=$2 incoming=$3 previous=$4 script=$5',
  "expected=absent",
  '[ -n "$previous" ] && expected=$(cksum < "$previous")',
  'hc exec --on "$machine" -i -- sh -c "$script" sh "$name" "$expected" < "$incoming"',
  "status=$?",
  'rm -f "$incoming" ${previous:+"$previous"}',
  "exit $status",
].join("\n");

const homes = new Map(); // machine -> its home, asked once

/** A machine's home folder (here: home()); throws when the machine can't say. */
export async function machineHome(machine) {
  if (!machine) return home();
  if (homes.has(machine)) return homes.get(machine);
  const result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine, timeout: PROBE_TIMEOUT_MS });
  if (result.code !== 0 || !result.stdout) throw new Error(`dossier personnel introuvable sur ${machine}`);
  homes.set(machine, result.stdout);
  return result.stdout;
}

/** A machine's Herdr app folder: appHome() here, ~/.config/herdr-app there. */
export async function machineAppDir(machine) {
  return machine ? `${await machineHome(machine)}/${REMOTE_APP_DIR}` : appHome();
}

export class StaleWrite extends Error {
  constructor(name) {
    super(`${name} a changé entre la lecture et l'écriture`);
    this.stale = true;
  }
}

const outboxDir = () => `${appHome()}/benni/outbox`;
const randomName = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;

function machineLayout(machine) {
  return machines().find((m) => m.name === machine)?.layout ?? null;
}

/** { [name]: text | null } for each name, or throws when the machine can't say. */
export async function readMachineFiles(machine, names) {
  const texts = {};
  if (!machine) {
    for (const name of names) texts[name] = await readTextFile(`${appHome()}/${name}`);
    return texts;
  }
  if (machineLayout(machine) !== "ready") throw new Error(`${machine} n'est pas connectée`);
  const probe = await exec("sh", ["-c", PROBE, "sh", ...names], { on: machine, timeout: PROBE_TIMEOUT_MS });
  const lines = probe.stdout.split("\n");
  if (probe.code !== 0 || lines.length < names.length + 1 || !lines[0]) throw new Error(`${machine} ne répond pas`);
  const dir = lines[0];
  for (const [index, name] of names.entries()) {
    if (lines[index + 1] !== "1") { texts[name] = null; continue; }
    const text = await readTextFile(`${dir}/${name}`, { on: machine });
    if (text === null) throw new Error(`${name} illisible sur ${machine}`);
    texts[name] = text;
  }
  return texts;
}

async function writeLocalFile(name, text, expected) {
  const path = `${appHome()}/${name}`;
  await exec("mkdir", ["-p", path.replace(/\/[^/]+$/, "")]);
  try {
    await writeTextFile(path, text, expected);
  } catch (error) {
    const current = await readTextFile(path);
    if ((current ?? null) !== expected) throw new StaleWrite(name);
    throw error;
  }
}

async function writeRemoteFile(machine, name, text, expected) {
  await exec("mkdir", ["-p", outboxDir()]);
  const incoming = `${outboxDir()}/${randomName()}.new`;
  const previous = expected === null ? "" : `${outboxDir()}/${randomName()}.old`;
  await writeTextFile(incoming, text, null);
  if (previous) await writeTextFile(previous, expected, null);
  const result = await exec("sh", ["-c", SEND_TO_MACHINE, "sh", machine, name, incoming, previous, REPLACE_IF_UNCHANGED], { timeout: WRITE_TIMEOUT_MS });
  if (result.code === 9) throw new StaleWrite(name);
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `écriture de ${name} sur ${machine} impossible`);
}

/** Writes `text` only if the file still holds `expected` (null: still absent); StaleWrite otherwise. */
export function writeMachineFile(machine, name, text, expected) {
  return machine ? writeRemoteFile(machine, name, text, expected) : writeLocalFile(name, text, expected);
}

export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Reads a JSON file fresh, lets `change` edit it, writes it back if it changed and the file didn't
 * move meanwhile (else reads again and replays `change`). `initial()` gives the content of an absent
 * file. Unparseable JSON throws: it is never overwritten. Returns the content written (or found).
 */
export async function changeMachineJson(machine, name, { initial, change }) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const current = (await readMachineFiles(machine, [name]))[name];
    let data;
    if (current === null) data = await initial();
    else {
      try { data = JSON.parse(current); } catch { throw new Error(`${name} n'est pas du JSON valide${machine ? ` sur ${machine}` : ""}`); }
    }
    const next = change(data) ?? data;
    const text = jsonText(next);
    if (text === current) return next;
    try {
      await writeMachineFile(machine, name, text, current);
      return next;
    } catch (error) {
      if (!error?.stale) throw error;
    }
  }
  throw new Error(`${name} change sans cesse${machine ? ` sur ${machine}` : ""} : écriture abandonnée`);
}
