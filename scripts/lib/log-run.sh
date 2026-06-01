#!/usr/bin/env bash
# Usage: log-run.sh <job> <kind> <command...>
# Runs the command, appends one health row to workers/logs/runs.jsonl.
set -uo pipefail
JOB="$1"; KIND="$2"; shift 2
LOG="$(dirname "$0")/../../workers/logs/runs.jsonl"
mkdir -p "$(dirname "$LOG")"
TS_START="$(date -Iseconds)"; START_MS=$(date +%s%3N)
TASK_ID=""
"$@"; EXIT=$?
END_MS=$(date +%s%3N); TS_END="$(date -Iseconds)"
[[ $EXIT -eq 0 ]] && STATUS="ok" || STATUS="fail"
jq -nc --arg ts_start "$TS_START" --arg ts_end "$TS_END" \
  --argjson duration_ms $((END_MS - START_MS)) --arg job "$JOB" --arg kind "$KIND" \
  --arg status "$STATUS" --argjson exit_code "$EXIT" --arg task_id "$TASK_ID" \
  '{ts_start:$ts_start, ts_end:$ts_end, duration_ms:$duration_ms, job:$job, kind:$kind, status:$status, exit_code:$exit_code, task_id:$task_id}' \
  >> "$LOG"
exit $EXIT
