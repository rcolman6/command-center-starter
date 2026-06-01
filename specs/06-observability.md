# Observability — Per-Agent Prompt + Output Review

> Build after the loop closes (build order step 6). The Captain's single most-asked question is **"what did the agent actually do?"** This spec answers it. For *any* task — and *any* stage of *any* pipeline — the Captain can review (a) the **exact prompt the agent received** and (b) the **agent's full transcript**, BOTH in the dashboard UI and from the CLI. Because everything is flat files, "review what the prompt to each agent does" is a one-click operation in the UI or a one-`cat` operation in the terminal.

This mirrors a **session-viewer pattern**: freeze the input, capture the full transcript, render both behind one card, and keep them as plain files Claude Code can read.

---

## What

Two artifacts, per agent run, always recoverable two ways:

| Artifact | What it is | Lives at | UI | CLI |
|----------|------------|----------|----|----|
| **Prompt** | the exact text the agent was given | `task.metadata.promptSnapshot` (in `tasks.json`) | Agent → **Prompt** tab | `jq` on `tasks.json` |
| **Output** | the full agent session/transcript | `workers/workspace/sessions/{task-id}.json` | Agent → **Output** tab | `cat` the session file |

If you remember one thing: **the input is on the task, the output is a file named by the task id.** Everything below is the plumbing that guarantees those two facts.

A separate, smaller concern is **system health** — *did the worker run, how long, did it crash.* That is a different question and lives (when wired up) in `workers/logs/runs.jsonl`, never mixed with prompts or transcripts. See §5; note that the health-log helper ships but is **not yet wired into cron**.

---

## Where

Every path below is real unless flagged. Verify against the repo before trusting a sketch.

| Path | Role | Status |
|------|------|--------|
| `dashboard/data/tasks.json` | holds `metadata.promptSnapshot` — the frozen prompt, per task | shipped |
| `workers/workspace/sessions/{task-id}.json` | the streamed transcript (`stream-json`), one JSON object per line | shipped |
| `workers/run-worker.sh` | stamps the snapshot (§1), tees the transcript (§2), stores the session id (§2) | shipped |
| `dashboard/app/api/sessions/[taskId]/route.ts` | GET that serves the session file to the UI | shipped |
| `dashboard/components/TaskCard.tsx` | the Agent view: **Prompt** / **Output** tabs + `SessionView` | shipped |
| `scripts/lib/log-run.sh` | health-log wrapper: runs a command, appends one row to `runs.jsonl` | **shipped but unwired** |
| `workers/logs/runs.jsonl` | the run-health log (one JSON row per tick) | **not present yet** (gitignored; created on first wrapped run) |

The last two are real files/intentions but operationally inert: `scripts/lib/log-run.sh` exists, yet `scripts/install-cron.sh` runs the worker directly (`bash workers/run-worker.sh >> workers/logs/cron.log 2>&1`) — it does **not** wrap the worker in `log-run.sh`, so `workers/logs/runs.jsonl` is never written. Treat §5 as a described, optional add-on, not as shipped behavior.

> **Ports.** This spec uses the canonical default `18424` throughout. The live instance is reconfigured to `18525` (see the repo `CLAUDE.md`); substitute as needed.

---

## How

### 1. `promptSnapshot` — the frozen prompt

The slash command file (`~/.claude/commands/worker/<name>.md`) is the *recipe*. But it can change tomorrow. The **promptSnapshot** is the *photograph*: the exact, fully-assembled prompt this specific run received. It is the ground truth of what the agent was told.

**Assembly (matches `workers/run-worker.sh` §6).** The worker builds the prompt string `$PROMPT` from the **task** (the WHAT), then appends the slash command body (the HOW), then an optional revision block:

1. `# Task: <title>`
2. The `description`.
3. `## Acceptance criteria` — each `acceptanceCriteria[]` as a checkbox line.
4. `## Output` — the output dir to write to (`workers/workspace/outputs/<id>/`) and the optional notes file.
5. `## How — slash command \`<name>\`` — the contents of `~/.claude/commands/worker/<name>.md`, only if a slash command is set and the file exists.
6. Any **revision section** — when `claudeNotes` starts with `[REVISION REQUESTED]`, the worker injects a `## REVISION REQUESTED` block pointing at the existing output dir and carrying the Captain's feedback (see `01-foundation.md` §3).

**The system prompt is NOT part of `$PROMPT`.** It is a separate, tiny `SYSTEM_BRIEF` heredoc defined inline in the worker and passed via `--append-system-prompt "$SYSTEM_BRIEF"` (see §2's invocation). It is *appended to* Claude Code's default agent prompt, so the agent keeps its full competence and only gains the headless-worker framing. **There is no `workers/system-prompt.md`** — one worker file is the whole story. The brief is therefore not captured in `promptSnapshot`; the snapshot is the task-plus-slash-command string the agent received as its user message.

**The PATCH (write `metadata.promptSnapshot`).** Three properties:

- It is **write-once** — the worker only stamps when `metadata.promptSnapshot` is empty, so the historical record survives even across revision passes.
- It is **best-effort** — a failed snapshot patch logs a `WARN` and never blocks the run.
- The **server merges metadata**, not the worker. The worker sends just `{metadata:{promptSnapshot:$p}}`; `dashboard/lib/data.ts → updateTask` merges that into existing `metadata` (`{ ...prev.metadata, ...updates.metadata }`) so a card branch and a worker snapshot coexist. The worker does **not** read-modify-write the metadata object itself.

```bash
# workers/run-worker.sh §7 — freeze the prompt (write-once; the server merges metadata)
if [ -z "$HAS_SNAPSHOT" ]; then
  patch "$(jq -nc --arg p "$PROMPT" '{metadata:{promptSnapshot:$p}}')" \
    || echo "WARN: promptSnapshot patch failed (non-fatal)"
fi
```

where `HAS_SNAPSHOT` was read from the claimed task (`.metadata.promptSnapshot // ""`) and `patch()` is the worker's `curl --fail -s -X PATCH "$API/$ID" ...` helper.

> **Why write-once?** A pipeline stage may heal (re-run) or a task may be revised (`--resume`). The *first* prompt is the one that defines the run's intent; later passes append to the session, not the snapshot. If you ever want the revision prompt too, it is already in the session file (next section), not the snapshot.

### 2. Session capture — the full transcript

The session file is the **per-agent output-of-record**. The worker uses **mode A: streamed `stream-json`** — `--output-format stream-json --verbose` emits one JSON object per line (system/hook lines, an init line carrying `session_id`, each `assistant`/`tool_use`, each `user`/`tool_result`, and a final `result`). stdout is `tee`'d to the session file, so you get the full step-by-step trace including every tool call — exactly "what did the agent *do*."

> A single-object mode (`--output-format json`, one `{ session_id, result, ... }` object) is the simpler fallback if rendering streamed JSON is too much on day one; the UI's `SessionView` already degrades to it (it renders `.result` when the file parses as a single object). But the shipped worker uses mode A, and the CLI recipes below assume it.

**The invocation (`workers/run-worker.sh` §8).** The session file is named by task id, exactly per `01-foundation.md` (`workers/workspace/sessions/{task-id}.json`). On a revision, the worker `--resume`s the stored `claudeSessionId` (assembled into the `RESUME` array) so the agent refines instead of restarting. `PIPESTATUS[0]` preserves Claude's real exit code through the `tee`.

```bash
# §8 — spawn Claude (stream-json → tee; PIPESTATUS keeps the real exit)
: > "$SESSION_FILE"
timeout "$TIMEOUT_SECONDS" claude -p --dangerously-skip-permissions \
  --output-format stream-json --verbose --model "$MODEL" \
  --append-system-prompt "$SYSTEM_BRIEF" "${RESUME[@]}" "$PROMPT" 2>&1 | tee "$SESSION_FILE"
AGENT_EXIT="${PIPESTATUS[0]}"
```

**Store the session id on the task (§9).** Pull `session_id` from the transcript (it appears on the init/system lines) and PATCH it as `claudeSessionId` — that is what `--resume` reads on the next revision pass.

```bash
# §9 — capture the session id (for --resume on a later revision)
SID="$(jq -rR 'fromjson? | .session_id // empty' "$SESSION_FILE" 2>/dev/null | tail -1)"
[ -n "$SID" ] && patch "$(jq -nc --arg s "$SID" '{claudeSessionId:$s}')" || true
```

That is the complete observability contract on the worker side: **PATCH the prompt in (write-once), `tee` the transcript out, PATCH the session id back.** Three lines of intent.

### 3. The UI surface

The `TaskCard` (the generic render target from `03-dashboard.md`) carries an **Agent view** with two tabs, driven by an `agentTab: 'prompt' | 'output'` state:

- **Prompt** — renders `task.metadata.promptSnapshot` in a monospace `<pre>` (it's already on the task; no fetch needed), or `"No prompt snapshot recorded."` when absent. This is the one-click answer to "what was this agent told?"
- **Output** — renders `<SessionView taskId notes file />`, which fetches the session file (via the route below), plus `task.claudeNotes` (the agent's summary) and a **link to `completionFile`** (the primary deliverable). For streamed JSON it renders each line as a row — assistant text, a `tool_use` (name + input), a `tool_result`, and the final `result` block. If the file parses as a single object, it falls back to showing `.result` (or the raw text).

```tsx
// dashboard/components/TaskCard.tsx — the Agent view
const [agentTab, setAgentTab] = useState<'prompt' | 'output'>('prompt');
const snapshot = task.metadata?.promptSnapshot as string | undefined;

{agentTab === 'prompt' && (
  <pre className="whitespace-pre-wrap font-mono text-xs">
    {snapshot ?? 'No prompt snapshot recorded.'}
  </pre>
)}
{agentTab === 'output' && (
  <SessionView taskId={task.id} notes={task.claudeNotes} file={task.completionFile} />
)}
```

**The API route — `/api/sessions/[taskId]`.** A thin GET that reads the task's session file and returns it. The session file is disposable scratch *outside* `dashboard/`, so it needs its own route (the card serves `completionFile` through `/api/files/[...path]`). The route resolves the path relative to the dashboard's cwd (`process.cwd()/../workers/workspace/sessions/`) and `await`s the `params` promise (Next.js dynamic-route convention); a missing file returns `404 {"error":"no session yet"}`.

```ts
// dashboard/app/api/sessions/[taskId]/route.ts
export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const p = path.join(process.cwd(), '..', 'workers', 'workspace', 'sessions', `${taskId}.json`);
  try {
    const raw = await fs.readFile(p, 'utf8');
    return new Response(raw, { headers: { 'content-type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'no session yet' }), { status: 404 });
  }
}
```

**Pipelines — walk a whole run.** The `/pipelines` run view (from `05-pipelines.md`) lists each stage of a run. Each stage row links to that stage's **task** — and the task opens its **Prompt/Output** tabs. So the Captain walks a run top to bottom and reads, per stage, exactly what that agent was told and what it produced. Because every stage is just a task, observability is free for pipelines — there is no second mechanism to build.

```
/pipelines/runs/<runId>
  stage: research    → task-...a1  [Prompt] [Output]   ✓ completed
  stage: draft       → task-...b2  [Prompt] [Output]   ✓ completed
  stage: review      → task-...c3  [Prompt] [Output]   ⟳ in_progress
```

### 4. The CLI surface — observability through Claude Code

Because the prompt is a field on the task and the session is a file named by task id, the Captain (or Claude Code itself) reviews everything with plain file reads. **No dashboard required.**

**What was agent X told?** (read the frozen prompt)

```bash
jq -r '.[] | select(.id=="task-1730000000-ab12") | .metadata.promptSnapshot' \
  dashboard/data/tasks.json
```

**What did it produce?** (read the full transcript)

```bash
cat workers/workspace/sessions/task-1730000000-ab12.json
```

**Just the agent's final message** (skip the tool noise; stream-json is one object per line, so `jq -rR 'fromjson?'` parses line-by-line):

```bash
jq -rR 'fromjson? | select(.type=="result") | .result // empty' \
  workers/workspace/sessions/task-1730000000-ab12.json | tail -1
```

**Every tool the agent invoked:**

```bash
jq -rR 'fromjson? | select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' \
  workers/workspace/sessions/task-1730000000-ab12.json
```

**Find a task by title, then read its prompt and output in one go:**

```bash
ID=$(jq -r '.[] | select(.title | test("thumbnail";"i")) | .id' dashboard/data/tasks.json | head -1)
jq -r --arg id "$ID" '.[] | select(.id==$id) | .metadata.promptSnapshot' dashboard/data/tasks.json
cat "workers/workspace/sessions/${ID}.json"
```

This is the payoff of "everything is flat files": the same review the dashboard gives you is one `jq` and one `cat` away, and Claude Code can do it for you on request.

### 5. Run health log (secondary — operational, not per-agent; SHIPPED BUT UNWIRED)

A separate concern, cheap to add. A tiny wrapper logs **whether the worker ran, how long, and whether it failed** — system health, *not* prompts or outputs. One JSON row per run, appended to `workers/logs/runs.jsonl`.

**Status today.** `scripts/lib/log-run.sh` exists and works, but it is **not wired into cron**: `scripts/install-cron.sh` schedules the worker directly (`bash workers/run-worker.sh >> workers/logs/cron.log 2>&1`), so `workers/logs/runs.jsonl` is never produced (it is also gitignored). To enable the health log, change the cron command to route through the wrapper. Until then, the worker's only on-disk run record is `workers/logs/cron.log` (raw stdout/stderr) and `lastRun` / `lastTaskId` in `dashboard/data/cron-config.json`.

**The wrapper (`scripts/lib/log-run.sh`, verbatim):**

```bash
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
```

**Schema (one line per run):**

```json
{ "ts_start": "2026-05-31T14:00:01Z", "ts_end": "2026-05-31T14:02:17Z",
  "duration_ms": 136000, "job": "run-worker", "kind": "worker",
  "status": "ok", "exit_code": 0, "task_id": "" }
```

`status` is `ok` on exit 0, else `fail`. `kind` distinguishes the spine worker from other cron jobs you may add. `task_id` is emitted empty by the wrapper (the worker tracks the per-tick task itself via `cron-config.json`'s `lastTaskId`).

**To wire it up**, install cron with the wrapper instead of calling the worker directly:

```
... scripts/lib/log-run.sh run-worker worker workers/run-worker.sh
```

**Did the worker run in the last hour? / Any failures today?** (once `runs.jsonl` exists)

```bash
tail -5 workers/logs/runs.jsonl                                  # last few ticks
jq -rs '.[] | select(.status=="fail") | "\(.ts_start) \(.job) exit=\(.exit_code)"' \
  workers/logs/runs.jsonl                                        # every failed run
```

> **The distinction, stated plainly:** `runs.jsonl` is **system health** — *did it run, how long, did it crash.* `metadata.promptSnapshot` + `workers/workspace/sessions/` are the **per-agent prompt/output review** — *what was the agent told, and what did it produce.* The Captain reaches for the first to answer "is the machine alive," and for the second to answer "what did the machine think." Don't conflate them; don't put prompts or transcripts in `runs.jsonl`.

### 6. What you can answer now

| Question | Where to look |
|----------|---------------|
| **What was agent X told?** | `task.metadata.promptSnapshot` → Prompt tab, or `jq '... .metadata.promptSnapshot' dashboard/data/tasks.json` |
| **What did it produce?** | `workers/workspace/sessions/{id}.json` → Output tab, or `cat` it; deliverable via `completionFile` |
| **Why did this stage heal / get revised?** | Compare the snapshot (original intent) vs. the session transcript (the resumed pass + the `[REVISION REQUESTED]` block in `claudeNotes`) |
| **What tools did the agent call?** | `jq` the `tool_use` lines in the session file (CLI snippet §4) |
| **Did the worker run recently?** | `tail workers/logs/cron.log`, or `dashboard/data/cron-config.json` (`lastRun` / `lastTaskId`); `runs.jsonl` once §5 is wired |
| **Did anything fail today?** | `jq 'select(.status=="fail")' workers/logs/runs.jsonl` — only after §5 is wired |
| **Walk a whole pipeline run** | `/pipelines/runs/<id>` → each stage's task → its Prompt/Output tabs |

Sections 1–3 are shipped and are the Captain's actual ask. §5 ships as a helper but is not yet wired into cron — bolt it on whenever you want the system-health view; it answers a different, smaller question.
