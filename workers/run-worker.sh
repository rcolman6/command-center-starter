#!/usr/bin/env bash
# Command Center worker — one cron tick.
#
# THE CONTRACT (the whole thing):
#   • The SCRIPT owns task status. The agent only writes files. There is no
#     output format the agent must follow, no API it must call, no status it
#     may set. It writes deliverables; the script does everything else.
#   • One tick = claim the highest-priority eligible task, run Claude headless,
#     then DETERMINISTICALLY record the result and set the terminal status.
#   • A claimed task can NEVER be left wedged in_progress. An EXIT trap
#     re-queues it to pending on any early exit — including a crash.
#   • Multi-stage pipelines: the worker sets ONLY the spine default —
#         metadata.autoMode == true  → completed     (auto/test stages + heals)
#         otherwise                   → needs_review  (review stages, standalone)
#     The dashboard pipeline-engine seeds every next stage, runs test gates, and
#     heals. The worker NEVER progresses pipelines. Two owners, no overlap.
#
# errexit is deliberately NOT used. Exit codes are checked explicitly, so an
# expected non-zero (e.g. a no-match grep) can never abort before the status
# is finalized — that exact bug class is what this design eliminates.
set -uo pipefail

# --- config ----------------------------------------------------------------
API="http://localhost:18525/api/tasks"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WS="$ROOT/workers/workspace"
LOG_DIR="$ROOT/workers/logs"
CRON_CFG="$ROOT/dashboard/data/cron-config.json"
CMD_DIR="$HOME/.claude/commands"
LOCK="/tmp/command-center-worker.lock"
TIMEOUT_SECONDS=1800          # Claude's own wall-clock budget (30 min)
STALE_LOCK_SECONDS=2100       # > timeout ⇒ holder is wedged; reclaim the lock
DEFAULT_MODEL="sonnet"
SUMMARY_MAX=600               # chars of the auto-summary kept as claudeNotes
COOLDOWN_SECONDS=3600         # pause this long after a provider 429 / usage-limit hit (1h)

# The agent's ENTIRE behavioral brief. Deliberately tiny and free of any
# output / PATCH / status contract — the script derives all of that. Appended
# to (not replacing) Claude Code's default agent prompt, so the agent keeps its
# full competence and only gains the headless-worker framing. There is no
# separate system-prompt.md to maintain: one worker file is the whole story.
read -r -d '' SYSTEM_BRIEF <<'BRIEF' || true
You are a Command Center worker running headless on a cron. No human is watching and you will not get a follow-up message, so work autonomously and to completion — never stop to ask for confirmation or clarification.

Write every deliverable as a flat, top-level file in the output directory named in the task. That directory is your only output surface: you do not set task status, call any API, or report back in any special format. Just produce the files; a human reviews them afterward.

If you cannot finish, do not fake success. Write a file named `failure-<reason>.md` (or begin your notes with `Blocked:`) explaining what stopped you and what you would need. The task will be parked for a human instead of advancing.
BRIEF

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
mkdir -p "$LOG_DIR" "$WS/outputs" "$WS/notes" "$WS/sessions"

# --- 0a. dependency preflight: fail fast if the toolchain is incomplete -----
# On a fresh client machine a missing binary is the most common silent break.
for _bin in curl jq timeout flock claude; do
  command -v "$_bin" >/dev/null 2>&1 \
    || { echo "ERROR: required command '$_bin' not in PATH. Aborting tick."; exit 1; }
done

# --- 0b. rate-limit cooldown: stand down while a recent 429 is still cooling -
# After a provider usage-limit hit, every retry tick re-stamps the on-disk
# transcript and bills against the next quota window when the cache rebuilds —
# so we hard-skip until the stamp elapses. State lives in cron-config.json
# (cooldownUntil + cooldownReason), NOT a /tmp file, so the Tasks dashboard can
# surface it as a banner. An expired stamp is cleared here so the next tick
# proceeds and the banner clears itself. Runs before the lock: a cooling worker
# never even contends for it.
if [ -f "$CRON_CFG" ]; then
  cd_until="$(jq -r '.cooldownUntil // ""' "$CRON_CFG" 2>/dev/null || echo "")"
  if [ -n "$cd_until" ]; then
    if [ "$(date +%s)" -lt "$(date -d "$cd_until" +%s 2>/dev/null || echo 0)" ]; then
      echo "Rate-limit cooldown active until $cd_until. Standing down."
      exit 0
    fi
    jq 'del(.cooldownUntil, .cooldownReason)' "$CRON_CFG" > "$CRON_CFG.tmp" \
      && mv "$CRON_CFG.tmp" "$CRON_CFG"
    echo "Cooldown expired — cleared and resuming."
  fi
fi

# The nested `claude` runs as its own session; clear CLAUDECODE so it never
# inherits a parent agent's context (also lets you test by hand from a session).
unset CLAUDECODE 2>/dev/null || true

# --- 1. single-instance lock (with stale-holder reclaim) -------------------
exec 200>"$LOCK"
if ! flock -n 200; then
  age=$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || date +%s) ))
  if [ "$age" -gt "$STALE_LOCK_SECONDS" ]; then
    fuser -k "$LOCK" 2>/dev/null; sleep 1
    flock -n 200 || exit 0
  else
    exit 0                                  # a live worker holds it — stand down
  fi
fi

# --- 2. finalize guard: a claimed task is NEVER left wedged in_progress -----
CLAIMED_ID=""        # set the moment we claim a task
FINALIZED=0          # set to 1 only once a terminal status patch has landed
finalize_guard() {
  if [ -n "$CLAIMED_ID" ] && [ "$FINALIZED" -ne 1 ]; then
    curl -s -X PATCH "$API/$CLAIMED_ID" -H 'content-type: application/json' \
      -d '{"status":"pending","claudeNotes":"[worker] exited before finalizing — re-queued for retry."}' \
      >/dev/null 2>&1 || true
  fi
  flock -u 200 2>/dev/null || true
}
trap finalize_guard EXIT

# --- 3. fetch the queue (always via the API; never read tasks.json) --------
tasks="$(curl --fail -s "$API")" || { echo "API unreachable at $API"; exit 0; }

# --- 4. select: lowest priority, then oldest; skip a task whose parent is
#         still pending/in_progress --------------------------------------------
task="$(jq -c --argjson all "$tasks" '
  [ .[]
    | select(.status == "pending")
    | select(
        .parentTaskId == null
        or ( .parentTaskId as $pid
             | ($all[] | select(.id == $pid) | .status) as $ps
             | ($ps != "pending" and $ps != "in_progress") )
      ) ]
  | sort_by(.priority, .createdAt) | .[0] // empty' <<<"$tasks")"

if [ -z "$task" ]; then                       # nothing to do — record the tick
  jq --arg t "$(now)" '.lastRun=$t' "$CRON_CFG" > "$CRON_CFG.tmp" && mv "$CRON_CFG.tmp" "$CRON_CFG"
  exit 0
fi

ID="$(jq -r '.id'                          <<<"$task")"
ENGINE="$(jq -r '.engine // "claude"'      <<<"$task")"   # 'claude' (default) | 'codex'
MODEL="$(jq -r ".model // \"$DEFAULT_MODEL\"" <<<"$task")" # claude model; ignored when engine=codex
CODEX_MODEL="$(jq -r '.metadata.codexModel // ""' <<<"$task")" # optional codex override; "" ⇒ codex config default
SLASH="$(jq -r '.slashCommand // ""'       <<<"$task")"
NOTES_IN="$(jq -r '.claudeNotes // ""'     <<<"$task")"
SESSION="$(jq -r '.claudeSessionId // ""'  <<<"$task")"
AUTO_MODE="$(jq -r '.metadata.autoMode // false'      <<<"$task")"
HAS_SNAPSHOT="$(jq -r '.metadata.promptSnapshot // ""' <<<"$task")"
OUT="$WS/outputs/$ID"; mkdir -p "$OUT"
NOTE="$WS/notes/$ID.md"; : > "$NOTE"          # fresh notes each run
SESSION_FILE="$WS/sessions/$ID.json"
LAST_MSG="$WS/sessions/$ID.last.txt"          # codex final-message capture (engine=codex only)

patch() { curl --fail -s -X PATCH "$API/$ID" -H 'content-type: application/json' -d "$1" >/dev/null; }

# --- 5. claim (server stamps startedAt on the in_progress transition) ------
patch '{"status":"in_progress"}'
CLAIMED_ID="$ID"                              # the finalize guard now protects it

# --- 6. assemble the prompt: task = the WHAT, slash command = the HOW ------
PROMPT="# Task: $(jq -r '.title' <<<"$task")

$(jq -r '.description' <<<"$task")

## Acceptance criteria
$(jq -r '.acceptanceCriteria[]? | "- [ ] " + .' <<<"$task")

## Output
Write all deliverables as flat files in: workers/workspace/outputs/$ID/
Optionally jot brief working notes in:   workers/workspace/notes/$ID.md
"
if [ -n "$SLASH" ] && [ -f "$CMD_DIR/$SLASH.md" ]; then
  PROMPT+="
## How — slash command \`$SLASH\`
$(cat "$CMD_DIR/$SLASH.md")
"
fi

# Revision pass: resume the prior session and refine the existing output.
# RESUME is the claude-specific flag array; IS_REVISION drives codex's `exec resume`.
RESUME=()
IS_REVISION=0
if [[ "$NOTES_IN" == "[REVISION REQUESTED]"* ]]; then
  IS_REVISION=1
  PROMPT+="
## REVISION REQUESTED
Your previous output is in workers/workspace/outputs/$ID/ — refine it in place, do
not start over. The Captain's feedback:
${NOTES_IN#"[REVISION REQUESTED]"}
"
  [ -n "$SESSION" ] && RESUME=(--resume "$SESSION")
fi

# --- 7. freeze the prompt (write-once; the server merges metadata) ---------
if [ -z "$HAS_SNAPSHOT" ]; then
  patch "$(jq -nc --arg p "$PROMPT" '{metadata:{promptSnapshot:$p}}')" \
    || echo "WARN: promptSnapshot patch failed (non-fatal)"
fi

# --- 8. spawn the agent (JSON stream → tee; PIPESTATUS keeps the real exit) -
# Two engines, one contract: both stream JSON we tee into $SESSION_FILE, both
# return their real exit via PIPESTATUS[0], and NEITHER sets task status.
#   • claude — stream-json; SYSTEM_BRIEF rides --append-system-prompt; --resume on revision.
#   • codex  — `codex exec --json`; codex has NO --append-system-prompt, so SYSTEM_BRIEF
#              is prepended to the prompt; revision uses `codex exec resume <thread_id>`.
: > "$SESSION_FILE"; : > "$LAST_MSG"
if [ "$ENGINE" = "codex" ]; then
  if ! command -v codex >/dev/null 2>&1; then
    # Missing backend: emit a clear line so the failure branch's note explains it,
    # then re-queue (consistent with any other failure — no dead-end status).
    echo "ERROR: engine 'codex' requested but 'codex' is not on PATH." | tee "$SESSION_FILE"
    AGENT_EXIT=127
  else
    # Codex's own default system prompt stays; our brief is prepended as a preamble.
    CODEX_PROMPT="$SYSTEM_BRIEF

$PROMPT"
    CODEX_COMMON=(--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
                  --json --output-last-message "$LAST_MSG")
    [ -n "$CODEX_MODEL" ] && CODEX_COMMON+=(--model "$CODEX_MODEL")
    if [ "$IS_REVISION" -eq 1 ] && [ -n "$SESSION" ]; then
      # `exec resume` continues the same thread; it has no --cd, so cd into root.
      # The subshell re-exports the agent's real exit (not tee's) explicitly.
      ( cd "$ROOT" && timeout "$TIMEOUT_SECONDS" codex exec resume "$SESSION" \
          "${CODEX_COMMON[@]}" "$CODEX_PROMPT" </dev/null 2>&1 | tee "$SESSION_FILE"
        exit "${PIPESTATUS[0]}" )
      AGENT_EXIT=$?
    else
      timeout "$TIMEOUT_SECONDS" codex exec \
        "${CODEX_COMMON[@]}" --cd "$ROOT" "$CODEX_PROMPT" </dev/null 2>&1 | tee "$SESSION_FILE"
      AGENT_EXIT="${PIPESTATUS[0]}"
    fi
  fi
else
  timeout "$TIMEOUT_SECONDS" claude -p --dangerously-skip-permissions \
    --output-format stream-json --verbose --model "$MODEL" \
    --append-system-prompt "$SYSTEM_BRIEF" "${RESUME[@]}" "$PROMPT" 2>&1 | tee "$SESSION_FILE"
  AGENT_EXIT="${PIPESTATUS[0]}"
fi

# --- 9. capture the session id (for resume on a later revision) ------------
# claude → .session_id on each stream-json line; codex → thread_id on thread.started.
if [ "$ENGINE" = "codex" ]; then
  SID="$(jq -rR 'fromjson? | select(.type=="thread.started") | .thread_id // empty' "$SESSION_FILE" 2>/dev/null | tail -1)"
else
  SID="$(jq -rR 'fromjson? | .session_id // empty' "$SESSION_FILE" 2>/dev/null | tail -1)"
fi
[ -n "$SID" ] && patch "$(jq -nc --arg s "$SID" '{claudeSessionId:$s}')" || true

# --- 9b. rate-limit detection → arm cooldown -------------------------------
# Strict patterns that match real provider CLI error strings only. Scan ONLY
# the last 20 lines: provider errors land at the tail right before exit, while
# spec/docs prose echoed mid-stream by the agent (which can contain phrases like
# "usage limit reached") would otherwise false-trip the detector.
RATE_LIMIT_REGEX='Claude AI usage limit reached|Claude Max usage limit reached|usage limit reached\.|429 Too Many Requests|rate.?limit.*(exceeded|reached)|weekly limit reached|5-hour limit reached|insufficient_quota|exceeded your current quota|hit your usage limit'
RATE_LIMITED=0
UNTIL=""
if tail -n 20 "$SESSION_FILE" 2>/dev/null | grep -qiE "$RATE_LIMIT_REGEX"; then
  RATE_LIMITED=1
  AGENT_EXIT=1                                  # force the failure branch (re-queue)
  UNTIL="$(date -u -d "+$COOLDOWN_SECONDS seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")"
  HIT="$(tail -n 20 "$SESSION_FILE" 2>/dev/null | grep -ioE "$RATE_LIMIT_REGEX" | head -1)"
  # A self-contained, copy-pasteable blurb the Captain can drop into Claude Code.
  REASON="$(cat <<EOF
Worker hit a provider rate limit and paused for $((COOLDOWN_SECONDS/60)) minutes (until ${UNTIL}).

Trigger: matched "${HIT}" while running task ${ID} — "$(jq -r '.title' <<<"$task")"${SLASH:+ (slash command: ${SLASH})}.
The task was re-queued to pending and retries automatically once the cooldown elapses.

Debug in Claude Code — paste this:
  The Command Center worker armed a rate-limit cooldown at $(now). Task ${ID}, slash command '${SLASH:-none}', matched the string '${HIT}'. Read the tail of workers/workspace/sessions/${ID}.json for the exact provider error and confirm it is a genuine usage-limit hit (not spec/doc prose the agent echoed back). Then tell me whether to wait it out or clear it now by deleting the "cooldownUntil" and "cooldownReason" keys from dashboard/data/cron-config.json.
EOF
)"
  echo "Rate limit detected (\"$HIT\"). Cooldown armed until $UNTIL."
  if [ -f "$CRON_CFG" ]; then
    jq --arg u "$UNTIL" --arg r "$REASON" '.cooldownUntil=$u | .cooldownReason=$r' \
      "$CRON_CFG" > "$CRON_CFG.tmp" && mv "$CRON_CFG.tmp" "$CRON_CFG"
  fi
fi

# --- 10. record the result DETERMINISTICALLY ------------------------------
if [ "$AGENT_EXIT" -eq 0 ]; then
  # 10a. completionFile — derived from the filesystem, NEVER from the agent.
  #      Prefer a recognizable primary file; else the first top-level file.
  CF="$(ls -1 "$OUT" 2>/dev/null | grep -iE '^(readme|report|output|result|index|draft|review)' | head -1)"
  [ -z "$CF" ] && CF="$(find "$OUT" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | sort | head -1)"
  CF_REL="$( [ -n "$CF" ] && echo "workers/workspace/outputs/$ID/$CF" )"

  # 10b. summary — also script-derived, requiring nothing special of the agent:
  #      notes file if it wrote one, else its final transcript message
  #      ({"type":"result","result":"…"}), else a generic line.
  if [ -s "$NOTE" ]; then
    NOTES_OUT="$(head -c "$SUMMARY_MAX" "$NOTE")"
  elif [ "$ENGINE" = "codex" ]; then
    # codex writes its final message to $LAST_MSG (--output-last-message); fall back to
    # the last agent_message in the JSONL if that file is somehow empty.
    if [ -s "$LAST_MSG" ]; then
      NOTES_OUT="$(head -c "$SUMMARY_MAX" "$LAST_MSG")"
    else
      NOTES_OUT="$(jq -rR 'fromjson? | select(.type=="item.completed") | .item | select(.type=="agent_message") | .text // empty' "$SESSION_FILE" 2>/dev/null | tail -1 | head -c "$SUMMARY_MAX")"
    fi
  else
    NOTES_OUT="$(jq -rR 'fromjson? | select(.type=="result") | .result // empty' "$SESSION_FILE" 2>/dev/null | tail -1 | head -c "$SUMMARY_MAX")"
  fi
  [ -z "$NOTES_OUT" ] && NOTES_OUT="Worker completed. See deliverables in workers/workspace/outputs/$ID/."

  # 10c. status — the spine default. autoMode (auto/test stages + heals) →
  #      completed, so the engine progresses; otherwise hold for the Captain.
  STATUS="needs_review"
  [ "$AUTO_MODE" = "true" ] && STATUS="completed"

  # 10d. bail signal — the agent declared it could not finish. Force review so a
  #      pipeline never auto-advances on a failed stage.
  case "${CF,,}" in failure*) STATUS="needs_review";; esac
  case "$NOTES_OUT" in Blocked:*|FAILED:*) STATUS="needs_review";; esac

  # 10e. the SCRIPT issues the terminal status patch (server stamps completedAt).
  #      FINALIZED flips only if it lands; otherwise the guard re-queues on exit.
  PAYLOAD="$(jq -nc --arg s "$STATUS" --arg n "$NOTES_OUT" --arg f "$CF_REL" \
    '{status:$s, claudeNotes:$n, completionFile:(if $f=="" then null else $f end)}')"
  if patch "$PAYLOAD"; then FINALIZED=1; fi
else
  # failure / timeout(124) / rate-limit: revert to pending; workspace persists.
  ERR="$(tail -c 400 "$SESSION_FILE" 2>/dev/null)"
  if [ "$RATE_LIMITED" -eq 1 ]; then
    NOTE_TXT="[worker] rate-limited — paused until ${UNTIL}; re-queued, retries after cooldown. ${ERR}"
  else
    NOTE_TXT="[worker error] ${ERR}"
  fi
  if patch "$(jq -nc --arg n "$NOTE_TXT" '{status:"pending", claudeNotes:$n}')"; then
    FINALIZED=1
  fi
fi

# --- 11. record the cron tick ---------------------------------------------
jq --arg t "$(now)" --arg id "$ID" '.lastRun=$t | .lastTaskId=$id' \
  "$CRON_CFG" > "$CRON_CFG.tmp" && mv "$CRON_CFG.tmp" "$CRON_CFG"
# the EXIT trap reconciles status and releases the lock
