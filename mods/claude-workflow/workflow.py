"""Reads Claude Code's workflow files for the claude-workflow mod; prints JSON.

  workflow.py runs <claude pid>           the session's workflow runs, newest first
  workflow.py steps <run dir>             phases and steps of one run, from its journal
  workflow.py transcript <file> <offset>  a step's transcript events from a byte offset
"""

import glob
import json
import os
import re
import sys

SKIPPED_ENTRY_TYPES = {"api-request", "api-request-blob", "api-request-shape", "attachment", "data-flow-records"}
RESULT_PREVIEW_CHARS = 6000
TEXT_CHARS = 20000


def config_dirs():
    candidates = [os.environ.get("CLAUDE_CONFIG_DIR")] + sorted(glob.glob(os.path.expanduser("~/.claude*")))
    return [d for d in dict.fromkeys(candidates) if d and os.path.isdir(os.path.join(d, "projects"))]


def session_of_pid(pid):
    for config_dir in config_dirs():
        path = os.path.join(config_dir, "sessions", f"{pid}.json")
        if os.path.isfile(path):
            with open(path) as f:
                return config_dir, json.load(f)["sessionId"]
    return None, None


def session_transcript(config_dir, session_id):
    matches = glob.glob(os.path.join(config_dir, "projects", "*", f"{session_id}.jsonl"))
    return matches[0] if matches else None


def launch_messages(transcript_path):
    """Run id -> (task id, script path), from the Workflow tool's launch results."""
    launches = {}
    if not transcript_path:
        return launches
    pattern = re.compile(r"Task ID: (\w+).*?Script file: (.*?)\n.*?Run ID: (wf_[\w-]+)", re.S)
    with open(transcript_path, errors="replace") as f:
        for line in f:
            if "Run ID: wf_" not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            for text in tool_result_texts(entry):
                for task_id, script, run_id in pattern.findall(text):
                    launches[run_id] = (task_id, script.strip())
    return launches


def tool_result_texts(entry):
    content = (entry.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    return [result_text(block.get("content")) for block in content if block.get("type") == "tool_result"]


def result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    return ""


def script_meta(script_path):
    meta = {"name": None, "description": None, "phases": []}
    if not script_path or not os.path.isfile(script_path):
        return meta
    with open(script_path, errors="replace") as f:
        source = f.read()
    block = re.search(r"export\s+const\s+meta\s*=\s*\{(.*?)\n\}", source, re.S)
    if not block:
        return meta
    body = block.group(1)
    quoted = r"""(['"`])((?:\\.|(?!\1).)*)\1"""
    for key in ("name", "description"):
        found = re.search(rf"\b{key}\s*:\s*{quoted}", body)
        if found:
            meta[key] = found.group(2)
    phases = re.search(r"\bphases\s*:\s*\[(.*?)\]\s*,?\s*$", body, re.S)
    if phases:
        meta["phases"] = [m.group(2) for m in re.finditer(rf"\btitle\s*:\s*{quoted}", phases.group(1))]
    return meta


def runs(pid):
    config_dir, session_id = session_of_pid(pid)
    if not session_id:
        return {"session": None, "runs": []}
    transcript = session_transcript(config_dir, session_id)
    session_dir = transcript[: -len(".jsonl")] if transcript else None
    found = []
    if session_dir:
        launches = launch_messages(transcript)
        for run_dir in glob.glob(os.path.join(session_dir, "subagents", "workflows", "wf_*")):
            run_id = os.path.basename(run_dir)
            task_id, script = launches.get(run_id, (None, None))
            final = os.path.join(session_dir, "workflows", f"{run_id}.json")
            journal = os.path.join(run_dir, "journal.jsonl")
            found.append({
                "runId": run_id,
                "dir": run_dir,
                "taskId": task_id,
                "running": not os.path.exists(final),
                "changedAt": os.path.getmtime(journal) if os.path.exists(journal) else os.path.getmtime(run_dir),
                **script_meta(script),
            })
    found.sort(key=lambda run: run["changedAt"], reverse=True)
    return {"session": session_id, "runs": found}


def steps(run_dir):
    by_agent = {}
    order = []
    journal = os.path.join(run_dir, "journal.jsonl")
    if os.path.exists(journal):
        with open(journal, errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                agent_id = entry.get("agentId")
                if not agent_id:
                    continue
                if entry.get("type") == "started":
                    order.append(agent_id)
                    by_agent[agent_id] = {"agentId": agent_id, "label": entry.get("label") or agent_id,
                                          "phase": entry.get("phase"), "state": "running", "result": None}
                elif entry.get("type") == "result" and agent_id in by_agent:
                    step = by_agent[agent_id]
                    step["state"] = "failed" if entry.get("error") else "done"
                    step["result"] = entry.get("result") if "result" in entry else entry.get("error")
    for agent_id in order:
        meta_path = os.path.join(run_dir, f"agent-{agent_id}.meta.json")
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                by_agent[agent_id]["model"] = json.load(f).get("model")
    return {"steps": [by_agent[a] for a in order]}


def short_input(name, tool_input):
    if not isinstance(tool_input, dict):
        return ""
    for key in ("command", "file_path", "pattern", "skill", "description", "url", "query", "prompt"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value
    return json.dumps(tool_input, ensure_ascii=False)


def transcript_events(path, offset):
    events = []
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    complete = data[: data.rfind(b"\n") + 1]
    for raw in complete.splitlines():
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        kind = entry.get("type")
        if kind in SKIPPED_ENTRY_TYPES or kind not in ("user", "assistant"):
            continue
        at = entry.get("timestamp")
        content = (entry.get("message") or {}).get("content")
        if kind == "user" and isinstance(content, str):
            events.append({"kind": "prompt", "text": content[:TEXT_CHARS], "at": at})
            continue
        if not isinstance(content, list):
            continue
        for block in content:
            block_type = block.get("type")
            if block_type == "text" and block.get("text", "").strip():
                events.append({"kind": "user" if kind == "user" else "text", "text": block["text"][:TEXT_CHARS], "at": at})
            elif block_type == "thinking" and block.get("thinking", "").strip():
                events.append({"kind": "thinking", "text": block["thinking"][:TEXT_CHARS], "at": at})
            elif block_type == "tool_use":
                events.append({"kind": "tool", "id": block.get("id"), "name": block.get("name"),
                               "summary": short_input(block.get("name"), block.get("input"))[:400], "at": at})
            elif block_type == "tool_result":
                events.append({"kind": "result", "id": block.get("tool_use_id"), "error": bool(block.get("is_error")),
                               "text": result_text(block.get("content"))[:RESULT_PREVIEW_CHARS], "at": at})
    return {"offset": offset + len(complete), "events": events}


def main():
    command, *args = sys.argv[1:]
    if command == "runs":
        output = runs(args[0])
    elif command == "steps":
        output = steps(args[0])
    elif command == "transcript":
        output = transcript_events(args[0], int(args[1]))
    else:
        raise SystemExit(f"unknown command {command}")
    json.dump(output, sys.stdout, ensure_ascii=False)


main()
