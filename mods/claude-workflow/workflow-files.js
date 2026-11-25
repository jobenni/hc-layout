import { exec, hc, appHome } from "herdr";

const READER = `${appHome()}/mods/claude-workflow/workflow.py`;
const READ_TIMEOUT_MS = 20000;

async function readWithPython(args) {
  const result = await exec("python3", ["-I", READER, ...args], { timeout: READ_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `workflow.py ${args[0]} a échoué`);
  return JSON.parse(result.stdout);
}

/** The Claude process in a terminal and the background tasks it reports as working. */
export async function readClaudeTerminal(terminal) {
  const result = await hc(["get", terminal, "--json"]);
  if (result.code !== 0) return null;
  const info = JSON.parse(result.stdout.split("\n")[0]);
  const workingTaskIds = Object.entries(info.records ?? {})
    .filter(([, record]) => record.app === "claude-code" && record.state === "working")
    .map(([taskId]) => taskId);
  return { pid: info.foreground?.pid ?? null, workingTaskIds };
}

/** @returns {Promise<{session: string | null, runs: WorkflowRun[]}>} */
export const readRuns = (pid) => readWithPython(["runs", String(pid)]);

/** @returns {Promise<{steps: WorkflowStep[]}>} */
export const readSteps = (runDir) => readWithPython(["steps", runDir]);

/** @returns {Promise<{offset: number, events: TranscriptEvent[]}>} */
export const readTranscript = (file, offset) => readWithPython(["transcript", file, String(offset)]);

export function transcriptFile(run, agentId) {
  return `${run.dir}/agent-${agentId}.jsonl`;
}

export function isRunInProgress(run, workingTaskIds) {
  return run.running && (!run.taskId || workingTaskIds.includes(run.taskId));
}

/**
 * Phases in the script's order, then any phase only the journal names.
 * @param {WorkflowRun} run @param {WorkflowStep[]} steps
 */
export function phasesWithSteps(run, steps) {
  const titles = [...run.phases];
  for (const step of steps) if (step.phase && !titles.includes(step.phase)) titles.push(step.phase);
  const phases = titles.map((title) => ({ title, steps: steps.filter((s) => s.phase === title) }));
  const unphased = steps.filter((s) => !s.phase);
  if (unphased.length) phases.push({ title: "Sans phase", steps: unphased });
  return phases;
}

/**
 * @typedef {{runId: string, dir: string, taskId: string | null, running: boolean, changedAt: number,
 *   name: string | null, description: string | null, phases: string[]}} WorkflowRun
 * @typedef {{agentId: string, label: string, phase: string | null, state: "running" | "done" | "failed",
 *   result: unknown, model?: string}} WorkflowStep
 * @typedef {{kind: "prompt" | "text" | "user" | "thinking" | "tool" | "result", text?: string, id?: string,
 *   name?: string, summary?: string, error?: boolean, at?: string}} TranscriptEvent
 */
