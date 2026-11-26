#!/bin/sh
# Runs one `claude -p` routine in its tab: the raw stream-json goes to <log>, the tab shows it
# readably, and <exit file> receives Claude's exit code once the stream is fully written.
#   run-routine.sh <log> <exit file> <claude arguments…>
log=$1
exit_file=$2
shift 2
here=$(dirname "$0")
mkdir -p "$(dirname "$log")"

# Through the user's own shell, so a `claude` function or alias in their rc file applies.
run_claude() {
  case "${SHELL##*/}" in
    fish) "$SHELL" -c 'claude $argv' -- "$@"; return ;;
    bash|zsh) "$SHELL" -ic 'claude "$@"' claude "$@"; return ;;
  esac
  claude "$@"
}

{ run_claude "$@" </dev/null; echo $? >"$exit_file.tmp"; } | tee "$log" | python3 -I "$here/routine.py" show
mv "$exit_file.tmp" "$exit_file"
