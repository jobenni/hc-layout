"""Reads Claude Code output for the benni-routines mod.

  routine.py show                 stdin: `claude -p --output-format stream-json`; prints it readably
  routine.py result <log>         the stream's session id and final result, as JSON
  routine.py summary <session id> the last assistant text of an interactive session, as JSON
"""

import glob
import json
import os
import sys

SUMMARY_CHARS = 4000
TOOL_SUMMARY_CHARS = 100
GREY = "\033[2m"
GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"


def tool_summary(tool_input):
    if not isinstance(tool_input, dict):
        return ""
    for key in ("command", "file_path", "pattern", "url", "query", "description", "prompt"):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value.replace("\n", " ")[:TOOL_SUMMARY_CHARS]
    return ""


def show():
    for line in sys.stdin:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            print(f"{GREY}Session {event.get('session_id')} · {event.get('model', '')}{RESET}\n", flush=True)
        elif kind == "assistant":
            for block in (event.get("message") or {}).get("content") or []:
                if block.get("type") == "text" and block.get("text", "").strip():
                    print(f"⏺ {block['text'].strip()}\n", flush=True)
                elif block.get("type") == "tool_use":
                    print(f"{GREY}⏺ {block.get('name')}({tool_summary(block.get('input'))}){RESET}", flush=True)
        elif kind == "result":
            failed = event.get("is_error") or event.get("subtype") != "success"
            seconds = round((event.get("duration_ms") or 0) / 1000)
            color, word = (RED, "Échec") if failed else (GREEN, "Terminé")
            print(f"\n{color}── {word} en {seconds}s ──{RESET}", flush=True)
            if event.get("session_id"):
                print(f"{GREY}Reprendre : claude --resume {event['session_id']}{RESET}", flush=True)


def result(log_path):
    session_id, final = None, None
    try:
        with open(log_path, errors="replace") as f:
            for line in f:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                session_id = event.get("session_id") or session_id
                if event.get("type") == "result":
                    final = event
    except OSError:
        pass
    text = (final or {}).get("result")
    print(json.dumps({
        "session_id": session_id,
        "found": final is not None,
        "is_error": bool(final and (final.get("is_error") or final.get("subtype") != "success")),
        "result": (text if isinstance(text, str) else "")[:SUMMARY_CHARS],
        "subtype": (final or {}).get("subtype"),
    }))


def config_dirs():
    candidates = [os.environ.get("CLAUDE_CONFIG_DIR")] + sorted(glob.glob(os.path.expanduser("~/.claude*")))
    return [d for d in dict.fromkeys(candidates) if d and os.path.isdir(os.path.join(d, "projects"))]


def summary(session_id):
    last_text = ""
    for config_dir in config_dirs():
        for path in glob.glob(os.path.join(config_dir, "projects", "*", f"{session_id}.jsonl")):
            with open(path, errors="replace") as f:
                for line in f:
                    if '"assistant"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if entry.get("type") != "assistant" or entry.get("isSidechain"):
                        continue
                    content = (entry.get("message") or {}).get("content")
                    texts = [b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
                    joined = "\n".join(t for t in texts if t.strip())
                    if joined.strip():
                        last_text = joined.strip()
    print(json.dumps({"summary": last_text[:SUMMARY_CHARS]}))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "show":
        show()
    elif command == "result" and len(sys.argv) > 2:
        result(sys.argv[2])
    elif command == "summary" and len(sys.argv) > 2:
        summary(sys.argv[2])
    else:
        sys.exit(__doc__)
