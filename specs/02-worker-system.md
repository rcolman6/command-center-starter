# Worker System

> `workers/run-worker.sh` — the cron-triggered loop that turns a `pending` task into a deliverable. This is the engine of the Spine. Build it after the dashboard skeleton (it talks to the API), then run it once by hand. Defers to `00-system-map.md` and `01-foundation.md`; if anything here disagrees with those, they win.

---

## What

The worker is **one cron tick**, embodied by a single bash script. There is no second worker, no poller, no daemon. Every N minutes cron runs `workers/run-worker.sh`; one tick does exactly this:

1. **Claim** the highest-priority eligible `pending` task.
2. **Run Claude headless** on it (the slash command is the HOW; the task is the WHAT).
3. **Deterministically record the result** and set the terminal status, then exit.

**The core principle (the load-bearing idea):**

> **The script owns task status. The agent only writes files.**

The script decides *which* task runs, claims it, sets every status transition, derives the deliverable from the filesystem, and re-queues on failure. The agent reads a prompt and writes files into an output directory — that is its **only** output surface. There is no output format the agent must follow, no API it must call, no status it may set. **Claude never sets its own status.** That separation is what makes the system safe to run unattended: status is mechanical, and the mechanism is in code you can read.

### What the worker owns

- **The task state machine** — every `pending → in_progress → needs_review | completed` transition, plus failure re-queue back to `pending`.
- **The claim** — atomically marking one task "mine" for this tick.
- **Retry / never-wedge** — a claimed task is *never* left stuck `in_progress`; an EXIT trap re-queues it to `pending` on any early exit, including a crash.
- **Finalize** — script-derived `completionFile`, `claudeNotes`, and the terminal status.

### What the worker does NOT own

- **Pipeline progression** — the worker sets ONLY the spine-default status. It never seeds the next stage, never runs test gates, never reads pipeline definitions. The **dashboard pipeline-engine** owns all progression (`05-pipelines.md`).
- **The actual work** — that's the **agent**. The worker hands it a prompt and an output directory; what gets written is Claude's job.

Everything the worker does to a task goes through the **dashboard API** (`/api/tasks` on `http://localhost:18424`). The worker never reads or writes `tasks.json` directly — `data.ts` is the only thing that touches the file, and the API is the only door in.

> **Local-port note.** The specs document `18424` as the canonical default. A given install may run on a different port to avoid a collision (see `CLAUDE.md`); the script's `API=` constant is the single source for that. Everything below uses the canonical `18424`.

---

## Where

| Thing | Path | Verified |
|-------|------|----------|
| The whole worker | `workers/run-worker.sh` | ✓ exists |
| The API it talks to | `/api/tasks` on `http://localhost:18424` (the `API=` constant) | ✓ |
| Deliverables | `workers/workspace/outputs/{task-id}/` (flat, top-level files only) | ✓ dir exists |
| Working notes | `workers/workspace/notes/{task-id}.md` | ✓ dir exists |
| Session capture | `workers/workspace/sessions/{task-id}.json` | ✓ dir exists |
| Per-run / cron log | `workers/logs/` (e.g. `cron.log`) | ✓ exists |
| Cron run state | `dashboard/data/cron-config.json` (`lastRun`, `lastTaskId`, cooldown keys) | ✓ exists |
| Lock file | `/tmp/command-center-worker.lock` | runtime |
| Slash commands (the HOW) | `~/.claude/commands/worker/<name>.md` | ✓ `commands/worker/` |

A task's `slashCommand` is `"worker/<name>"`; it resolves to `~/.claude/commands/worker/<name>.md`. The worker injects that file's **body** into the prompt — see *How → Assemble the prompt*.

> **There is no `workers/system-prompt.md`.** The agent's behavioral brief is an inline heredoc (`SYSTEM_BRIEF`) defined in the script and passed via `--append-system-prompt`. One worker file is the whole story (`ls workers/system-prompt.md` → no such file).

---

## How

The load-bearing mechanics, accurate to the script. The central rule throughout: **the script owns status; the agent only writes files.**

### `set -uo pipefail` — errexit is deliberately OFF

The script runs under `set -uo pipefail`. **`errexit` (`set -e`) is deliberately NOT used.** Exit codes are checked explicitly, so an *expected* non-zero (e.g. a `grep` with no match, a `find` on an empty dir) can never abort the tick before the status is finalized. Eliminating that exact bug class — an early abort leaving a task wedged — is the whole point.

### The EXIT-trap finalize guard — a claimed task is never left `in_progress`

Two variables track the claim: `CLAIMED_ID` (set the moment a task is claimed) and `FINALIZED` (set to `1` only once a terminal-status PATCH lands). A single `trap finalize_guard EXIT` is installed right after the lock. On *any* exit — clean, error, or crash — the guard:

- if `CLAIMED_ID` is set and `FINALIZED != 1`, PATCHes the task back to `status: "pending"` with a note (`[worker] exited before finalizing — re-queued for retry.`), so it retries next tick;
- releases the lock (`flock -u 200`).

This is why there is **no `failed` status and no wedged `in_progress`**: a claimed task always ends up either terminal (`needs_review`/`completed`) or back in the queue.

### Single-instance flock + stale-lock reclaim

The script opens fd 200 on `/tmp/command-center-worker.lock` and `flock -n`s it.

- If a **live** worker already holds it → **exit 0** (never run two at once; two runs would double-claim).
- **Stale reclaim:** if the lockfile's mtime age exceeds `STALE_LOCK_SECONDS` (2100s = 35 min, just past Claude's 30-min `TIMEOUT_SECONDS`), the holder is wedged — `fuser -k` it, `sleep 1`, and retry the lock once (`flock -n 200 || exit 0`).

A clean tick holds the lock for its whole run; the finalize guard releases it on exit.

### Dependency preflight + cooldown (before the lock)

- **Preflight.** `curl jq timeout flock claude` must all be on PATH; a missing binary aborts the tick with a clear error (`exit 1`). This is the most common silent break on a fresh machine.
- **Rate-limit cooldown.** State lives in `cron-config.json` (`cooldownUntil` ISO + `cooldownReason` blurb), *not* `/tmp`, so the dashboard can surface it. If `cooldownUntil` is still in the future → log and **exit 0** (a cooling worker never even contends for the lock); if elapsed → delete both keys and proceed (self-clearing). See *Rate-limit cooldown* below.
- **`unset CLAUDECODE`** so the nested `claude` runs as its own session and never inherits a parent agent's context (also lets you test by hand from inside a session).

### One tick, step by step

1. **Fetch the queue.** `curl --fail` the API. If unreachable, log and **exit 0** (cron retries). **Never read `tasks.json` directly.**

2. **Select the task** (one `jq` pass over the full list). Among `status == "pending"`:
   - lowest `priority` wins, ties broken by oldest `createdAt` (`sort_by(.priority, .createdAt)`);
   - **skip any task whose `parentTaskId` points at a task still `pending` or `in_progress`** — the parent's status is looked up in the full list (`$all`), and the child is eligible only when the parent is *not* in those two states (or has no parent).
   - Take `.[0]`. If nothing is eligible, update `cron-config.lastRun` and **exit 0**.

3. **Claim it.** `PATCH {"status":"in_progress"}`. The **server** stamps `startedAt` on the transition — the client sends only the status. Immediately set `CLAIMED_ID="$ID"` so the finalize guard now protects it.

4. **Assemble the prompt** — task = the WHAT, slash command = the HOW. In order:
   - a `# Task:` block: `title`, `description`, `acceptanceCriteria` rendered as a `- [ ]` checklist, and an `## Output` instruction pointing at `workers/workspace/outputs/$ID/`;
   - if `slashCommand` is set and `~/.claude/commands/<slashCommand>.md` exists, append a `## How — slash command` section with that file's body;
   - a `## REVISION REQUESTED` section *only if* `claudeNotes` starts with the literal `[REVISION REQUESTED]` (see *The revision loop*).
   The system brief is **not** part of this prompt string — it is passed separately via `--append-system-prompt`.

5. **Freeze the prompt (write-once).** If `metadata.promptSnapshot` is not already set, `PATCH metadata.promptSnapshot = <assembled prompt>`. `metadata` merges server-side (it does not replace — `01-foundation.md`). A failed snapshot PATCH is non-fatal (warns, continues). This is what the observability view reads back (`06-observability.md`).

6. **Spawn the agent (JSON stream → tee, real exit via PIPESTATUS).** The worker branches on `task.engine`; both engines stream JSON into `sessions/{id}.json`, return their real exit via `PIPESTATUS[0]`, and set **no** status. Only the spawn differs.

   **`engine: "claude"` (default).**
   ```
   timeout 1800 claude -p --dangerously-skip-permissions \
     --output-format stream-json --verbose --model "$MODEL" \
     --append-system-prompt "$SYSTEM_BRIEF" [--resume "$SESSION"] "$PROMPT" 2>&1 | tee "$SESSION_FILE"
   AGENT_EXIT="${PIPESTATUS[0]}"
   ```
   - `--output-format stream-json --verbose`, with stdout+stderr tee'd live into `sessions/{id}.json` (so the capture survives even a mid-run kill).
   - Because the run is piped into `tee`, `$?` would be `tee`'s exit; the **real** Claude exit code is taken from `PIPESTATUS[0]`.
   - `timeout 1800` = 30 min; a wedge yields exit `124`, handled by the failure branch.
   - `--resume "$SESSION"` is added only on a revision pass.
   - `--append-system-prompt "$SYSTEM_BRIEF"` *augments* Claude Code's default agent prompt (it does not replace it), so the agent keeps full competence and only gains the headless-worker framing.

   **`engine: "codex"`.** Runs `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "$ROOT" --output-last-message "$LAST_MSG" "$CODEX_PROMPT"`, same tee + `PIPESTATUS[0]`. Three differences from claude, all forced by the codex CLI:
   - **No `--append-system-prompt`** — codex has no such flag, so `SYSTEM_BRIEF` is *prepended* to the prompt (`$CODEX_PROMPT = "$SYSTEM_BRIEF\n\n$PROMPT"`).
   - **Model** comes from codex's own `~/.codex/config.toml` default; `--model` is passed only if `metadata.codexModel` is set (config over hardcoding — no claude `ModelId` leaks in).
   - **Revision** uses `codex exec resume "$SESSION" …` (which has no `--cd`, so the worker `cd "$ROOT"` first) instead of `--resume`.
   - A codex task whose backend is missing (`command -v codex` fails) takes the failure branch with a clear note rather than wedging — consistent with any other failure.

7. **Capture the session id.** claude: parse the last `.session_id` from the stream-json transcript (`jq -rR 'fromjson? | .session_id // empty' … | tail -1`). codex: parse `thread_id` from the `thread.started` event. Either way, `PATCH claudeSessionId` if present (needed for resume on a later revision).

8. **Rate-limit detection.** Scan **only the last 20 lines** of the session file against a strict provider-error regex (`Claude AI/Max usage limit reached`, `usage limit reached.`, `429 Too Many Requests`, `rate.?limit … exceeded|reached`, weekly/5-hour variants). Tail-only on purpose: spec/docs prose the agent echoes mid-stream must not false-trip it. A hit forces `AGENT_EXIT=1` (failure branch) and arms the cooldown (see below).

9. **Record the result DETERMINISTICALLY.**

   **Success (`AGENT_EXIT == 0`):**
   - **`completionFile`** — derived from the filesystem, **never** from the agent. Prefer a top-level file in `outputs/{id}/` whose name starts (case-insensitive) with `readme|report|output|result|index|draft|review`; else the alphabetically-first top-level file. Stored as a **repo-relative** path, or `null` if the dir is empty.
   - **`claudeNotes`** — also script-derived, requiring nothing special of the agent: the notes file (`notes/{id}.md`) if it wrote one, truncated to `SUMMARY_MAX` (600) chars; else the engine's final message (claude: the `{"type":"result","result":"…"}` transcript line; codex: the `--output-last-message` file); else a generic "see deliverables" line.
   - **status — the spine default.** `metadata.autoMode == true → completed` (so the engine can progress an auto/test stage or a heal); **otherwise → `needs_review`**. *There is no slash-command allowlist* — `autoMode` is the only thing that auto-completes.
   - **bail signal overrides to `needs_review`.** If `completionFile`'s basename starts `failure`, or the notes start with `Blocked:` or `FAILED:`, force `needs_review` so a pipeline never auto-advances on a failed stage (never loops forever — `01-foundation.md`).
   - **The script issues the terminal PATCH** (`{status, claudeNotes, completionFile}`; server stamps `completedAt`). `FINALIZED=1` flips only if the PATCH lands; otherwise the guard re-queues on exit.

   **Failure (`AGENT_EXIT != 0`, incl. timeout `124` and rate-limit):** PATCH `{status:"pending", claudeNotes:<error tail>}` — a rate-limit note names the cooldown end; otherwise `[worker error] <last ~400 chars of session>`. The workspace **persists** so a retry can resume context. `FINALIZED=1` only if that PATCH lands.

10. **Record the cron tick.** Update `cron-config.lastRun` and `lastTaskId`. The EXIT trap then reconciles status and releases the lock.

### The agent's system brief (`SYSTEM_BRIEF`, inline)

The entire behavioral brief is a heredoc in the script, passed via `--append-system-prompt`. It is deliberately tiny and free of any output/PATCH/status contract — the script derives all of that. Verbatim:

```
You are a Command Center worker running headless on a cron. No human is watching and you will not get a follow-up message, so work autonomously and to completion — never stop to ask for confirmation or clarification.

Write every deliverable as a flat, top-level file in the output directory named in the task. That directory is your only output surface: you do not set task status, call any API, or report back in any special format. Just produce the files; a human reviews them afterward.

If you cannot finish, do not fake success. Write a file named `failure-<reason>.md` (or begin your notes with `Blocked:`) explaining what stopped you and what you would need. The task will be parked for a human instead of advancing.
```

### The revision loop

When the Captain clicks **Revise**, the API sets the task back to `pending` and prefixes `claudeNotes` with the literal `[REVISION REQUESTED]`. The worker keys off that prefix:

1. **Detect** the `[REVISION REQUESTED]` prefix on `claudeNotes`.
2. **Inject** a `## REVISION REQUESTED` section into the prompt, pointing the agent at its prior output dir, telling it to *refine in place — do not start over*, and including the Captain's notes (the prefix stripped with `${NOTES_IN#"[REVISION REQUESTED]"}`).
3. **`--resume "$SESSION"`** (only if a `claudeSessionId` exists) so Claude continues the *same* session rather than restarting blank.

The whole feedback mechanism is structured notes feeding the next autonomous run — no chat. The persisted output dir and session id are what make it continuous.

### Pipelines: the worker does not progress them

A task may carry `pipelineRunId` / `pipelineStage`. **The worker treats it like any other task** — it runs the slash command and records completion via the spine-default status only. It does **not** advance the pipeline, seed the next stage, or read pipeline definitions. There is exactly one pipeline engine, behind the task-update API: when the API records a stage task's completion, *it* calls the engine (`05-pipelines.md`). Concretely:

- a **`review`-gate** stage (no `autoMode`) lands in `needs_review` → the engine waits for the Captain;
- an **`auto`/`test`** stage carries `metadata.autoMode == true` → it `completed`s, and the API's engine call seeds the next stage.

So the worker stays dumb about pipelines on purpose. One engine, one door.

### Rate-limit cooldown

A provider usage-limit / `429` is not an ordinary failure: retrying every tick re-stamps the on-disk transcript and bills against the next quota window when the cache rebuilds. So the worker **hard-stands-down** for `COOLDOWN_SECONDS` (3600s = 1h):

- **Detection** is tail-only (last 20 lines, strict regex — see step 8) to avoid false trips on echoed prose. A hit forces the failure branch (task → `pending`, retries after cooldown).
- **State** is written to `cron-config.json`: `cooldownUntil` (ISO, now + 1h) and `cooldownReason` (a self-contained, copy-pasteable blurb naming the task, the matched string, and a "paste this into Claude Code" prompt). In `cron-config.json` (not `/tmp`) so the dashboard can surface it as a banner.
- **Stand-down + self-clear** happens before the lock each tick: still cooling → `exit 0`; elapsed → delete both keys and proceed.

---

## Failure-safety invariants (true everywhere, never violated)

- **One worker at a time.** The `flock` is non-negotiable; two runs would double-claim.
- **A claimed task is never wedged.** The EXIT-trap finalize guard re-queues any un-finalized claim to `pending` and always releases the lock — even on crash.
- **Stale-lock reclaim.** A holder older than 35 min is `fuser -k`'d so a wedged run can't block the queue forever.
- **The agent never sets status.** Status comes only from the worker's branch logic. If you ever let Claude PATCH `status`, stop — that is the one thing it must not do.
- **Failure reverts to `pending`, never a dead end.** There is no `failed` status. Only an *agent-declared* bail (`failure*` file or `Blocked:`/`FAILED:` notes) parks in `needs_review`.
- **Never read `tasks.json` directly.** Always the API.
- **Cool down after a rate limit.** Hard stand-down for an hour; self-clearing.

---

## Done when

- Running `workers/run-worker.sh` by hand on a queue with one `pending` task: claims it (`in_progress`), runs Claude, drops a file in `outputs/{id}/`, and the task lands in `needs_review` (or `completed` if `autoMode`) with a `completionFile` and `claudeNotes`.
- A second concurrent invocation exits 0 immediately (lock held).
- Killing Claude mid-run (or a 30-min timeout) reverts the task to `pending` with an error note; the next run retries. Crashing before finalize does the same (the EXIT-trap guard).
- `metadata.promptSnapshot` and `sessions/{id}.json` are both populated — observability (`06`) has what it needs.

Next: `03-dashboard.md` (the surface that creates tasks and reviews the output).
