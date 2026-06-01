# Foundation

> The bedrock spec. The directory layout, the Task object/schema, config, and the build order. Every other spec in this pack assumes the definitions here. Build this first.

---

## What

"Foundation" is the data and structure layer the rest of the system stands on. It owns:

- **The directory layout** — the barebones tree of the repo, and which dirs are committed vs. disposable.
- **The Task object** — the one canonical schema (`dashboard/lib/types.ts`) every other spec references, plus the four statuses and the lifecycle that moves a task between them.
- **The task data-access contract** — `dashboard/lib/data.ts` is the *only* module that reads/writes `tasks.json`. The merge-vs-replace rules for PATCH live here.
- **Config** — `config/paths.json` (external paths) and `dashboard/data/cron-config.json` (the worker switch). The schema/shape of each.
- **The build order** — the sequence in which the spine, then the engine, is assembled.

What it does **not** own (later specs):

- The worker loop, claim/finalize logic, prompt assembly → `02-worker-system.md`.
- The dashboard pages, API route handlers, and review card → `03-dashboard.md`.
- How to author a `worker/*` slash command → `04-slash-commands.md`.
- The pipeline engine, schema, and run records → `05-pipelines.md`.
- Observability (prompt snapshot + session capture views) → `06-observability.md`.
- Cron install + the Settings toggle → `07-config-and-cron.md`.

Three moving parts, no external infrastructure: a **task queue** (JSON files), a **worker** (`workers/run-worker.sh` on cron), and a **dashboard** (Next.js on `http://localhost:18424`). The script owns the state machine; Claude owns the work.

---

## Where

Real files/dirs and their roles. Every path below was verified to exist in this repo.

### The Task data model + access

| Path | Role |
|------|------|
| `dashboard/lib/types.ts` | Canonical `Task` interface + `TaskStatus` and `ModelId` unions. The schema in the **How** section is copied from here. |
| `dashboard/lib/data.ts` | The ONLY module that reads/writes `tasks.json`. `getTasks` / `getTask` / `createTask` / `updateTask` / `deleteTask`. Owns the metadata-merge and timestamp-stamping rules. |
| `dashboard/lib/utils.ts` | `generateId()` → `task-{Date.now()}-{base36 random}`. |
| `dashboard/lib/file-mutex.ts` | `withFileLock` + `atomicWriteJson` — the write lock for `tasks.json`. The race is real; keep it. |
| `dashboard/data/tasks.json` | The task queue: a JSON array of `Task`. Always accessed via `data.ts`. |

### Config + worker state

| Path | Role |
|------|------|
| `config/paths.json` | The single source of truth for external paths. Keys: `projects`, `knowledgeBase`, `outputs`. |
| `config/pipelines/<id>.json` | Pipeline definitions (Layer 2). Currently `content-draft.json`. |
| `dashboard/data/cron-config.json` | The worker switch: `enabled`, `intervalMinutes`, `lastRun`, `lastTaskId`. The worker may add `cooldownUntil` / `cooldownReason` at runtime on a rate-limit hit. |
| `dashboard/data/pipeline-runs.json` | Pipeline run records (Layer 2), a JSON array. |

### Dashboard shell (detail in `03-dashboard.md`)

| Path | Role |
|------|------|
| `dashboard/app/tasks/page.tsx` | The spine page: list + create + needs-review. |
| `dashboard/app/pipelines/page.tsx` | Pipeline view (Layer 2). |
| `dashboard/app/settings/page.tsx` | Worker on/off + interval. |
| `dashboard/app/api/tasks/route.ts` | `GET` (list) + `POST` (create). |
| `dashboard/app/api/tasks/[id]/route.ts` | `GET` + `PATCH` + `DELETE` a single task. |
| `dashboard/app/api/cron-config/route.ts` | `GET` + `PUT` (drives crontab). |
| `dashboard/app/api/pipelines/route.ts` | Lists `config/pipelines/*.json`. |
| `dashboard/app/api/pipeline-runs/route.ts`, `dashboard/app/api/pipeline-runs/[id]/route.ts` | Run records CRUD (Layer 2). |
| `dashboard/app/api/files/[...path]/route.ts` | Serves deliverable files to the review card. |
| `dashboard/app/api/sessions/[taskId]/route.ts` | Serves the captured agent session (observability). |
| `dashboard/app/api/slash-commands/route.ts` | Lists available `worker/*` slash commands for the create form. |
| `dashboard/components/TaskForm.tsx`, `dashboard/components/TaskCard.tsx` | Create/edit form; the generic review card. |
| `dashboard/lib/cron.ts` | Builds the cron expression + installs/removes the crontab entry. |
| `dashboard/lib/pipelines.mjs` | Canonical pipeline Zod schema (Layer 2). |
| `dashboard/lib/pipelines.ts`, `dashboard/lib/pipeline-runs.ts`, `dashboard/lib/pipeline-engine.ts` | Pipeline read/write + the one progression engine (Layer 2). |

### Worker + workspace (detail in `02-worker-system.md`)

| Path | Role |
|------|------|
| `workers/run-worker.sh` | The cron entry — the whole worker loop. The system prompt / brief is built inline here (there is **no** separate `system-prompt.md`). |
| `workers/lib/` | Present but empty — reserved for shell helpers. |
| `workers/logs/worker-*.log`, `workers/logs/cron.log`, `workers/logs/runs.jsonl` | Per-run stdout/stderr, cron log, and the run ledger. Gitignored. |
| `workers/workspace/` | DISPOSABLE scratch; gitignored (only `.gitkeep` tracked). |
| `workers/workspace/outputs/{task-id}/` | Deliverables — flat, top-level files only. The worker picks the primary file as `completionFile`. |
| `workers/workspace/notes/{task-id}.md` | Claude's working notes (first ~600 chars → `claudeNotes`). |
| `workers/workspace/sessions/{task-id}.json` | Full agent session capture (observability). |

### Scripts + slash commands

| Path | Role |
|------|------|
| `scripts/install-cron.sh` | Writes the crontab line (or use `dashboard/lib/cron.ts`). |
| `scripts/validate-pipelines.sh` | Validates `config/pipelines/*.json` against the Zod schema. |
| `scripts/trigger-pipeline.sh` | Kicks off a pipeline run from the CLI (Layer 2). |
| `scripts/lib/log-run.sh` | Appends a row to `workers/logs/runs.jsonl`. |
| `commands/worker/*.md` | The slash commands (the HOW) live in-repo here (e.g. `draft-doc.md`, `review-doc.md`, `research-topic.md`, `weekly-report.md`, `summarize-transcript.md`). The worker resolves them at runtime from `$HOME/.claude/commands/worker/<name>.md`, so the in-repo copies must be linked/copied into `~/.claude/commands/`. |
| `skills/setup-pipeline/` | The pipeline-authoring skill. |

**Rules:**
- `workers/workspace/` is disposable scratch — gitignored.
- Deliverables go in `workers/workspace/outputs/{task-id}/` at the **top level only** — no nested dirs.
- Nothing reads `tasks.json` directly. Everything goes through `dashboard/lib/data.ts`.

---

## How

### The four statuses

Exactly **four**, no others. No `failed`, no `blocked`.

```
        create (default: pending)
              │
              ▼
        ┌─► pending ──────────────────────────────┐
        │      │ worker claims (sets in_progress)  │
        │      ▼                                    │
        │  in_progress                              │
        │      │ Claude finishes                    │
        │   ┌──┴───────────┐                        │
        │   │ exit ≠ 0      │ exit 0                 │
        │   ▼               ▼                        │
        └─ pending     needs_review ◄── (default landing on success)
        (revert,           │   │
         retry next        │   │ auto-complete (metadata.autoMode === true)
         tick)             │   ▼
                           │  completed
                           │
        Captain "Approve"  → completed
        Captain "Revise"   → pending (notes prefixed "[REVISION REQUESTED]")
```

| Status | Meaning |
|--------|---------|
| `pending` | Queued. The worker will claim it on the next tick. |
| `in_progress` | The worker is running Claude on this task right now. |
| `needs_review` | Deliverable is ready in `workspace/outputs/{id}/`. The Captain reviews. **Most tasks land here.** |
| `completed` | Approved (or an `autoMode` stage finished). Terminal. |

**Who sets status:** the worker (the script), always. The agent never sets its own status — it only writes deliverables and PATCHes `claudeNotes` / `completionFile`. An EXIT trap re-queues a claimed task to `pending` on any early exit, so a task is never left wedged in `in_progress`.

**Auto-completion.** On success the worker writes `needs_review` by default; if `metadata.autoMode === true` (auto/test pipeline stages and self-heal tasks) it writes `completed` instead so the pipeline engine can progress.

**Failure handling (no `failed` status).** A non-zero exit — including the timeout (exit 124) and an armed rate-limit cooldown — reverts the task to `pending` with an error note in `claudeNotes`; cron retries it next tick. If the agent declares itself stuck (writes a `completionFile` named `failure*`, or notes starting with `Blocked:` / `FAILED:`), the worker holds the task in `needs_review` for the Captain to triage instead of looping forever — and a failed pipeline stage never auto-advances.

**The revision loop (load-bearing).** When the Captain clicks **Revise**, the dashboard sets `claudeNotes` to `"[REVISION REQUESTED]\n{notes}"` and status back to `pending`. The worker detects that literal prefix, injects a "REVISION REQUESTED" section into the prompt pointing at the existing output dir, and `--resume`s the prior `claudeSessionId` so Claude refines the existing work rather than starting over.

### The Task object (CANONICAL — every spec uses this)

Stored in `dashboard/data/tasks.json` as an array. Defined in `dashboard/lib/types.ts`. Read/written only via `dashboard/lib/data.ts`. This block is reproduced verbatim from `types.ts`:

```ts
export type ModelId = 'sonnet' | 'opus' | 'haiku';
export type AgentEngine = 'claude' | 'codex';   // which CLI the worker spawns; defaults to 'claude'
export type TaskStatus = 'pending' | 'in_progress' | 'needs_review' | 'completed';

export interface Task {
  id: string;                         // "task-{timestamp}-{random}"
  title: string;
  description: string;                // what to do, where inputs are
  status: TaskStatus;
  priority: 0 | 1 | 2 | 3 | 4 | 5;    // 0 = above everything; 1 = highest normal; 3 = default
  engine: AgentEngine;                // 'claude' (default) | 'codex' — which CLI the worker runs
  model: ModelId;                     // claude model; defaults to 'sonnet'. Ignored when engine === 'codex'.

  slashCommand: string | null;        // "worker/<name>" — the HOW. Injected into the prompt.
  acceptanceCriteria: string[];       // rendered as checkboxes on the card

  parentTaskId: string | null;        // blocks this task until the parent leaves pending/in_progress

  // --- worker-owned outputs (the agent PATCHes notes/completionFile; the worker owns status) ---
  claudeNotes: string;                // first 500 chars of notes file, or agent-PATCHed summary
  completionFile: string | null;      // repo-relative path to the primary deliverable
  claudeSessionId: string | null;     // captured from the run; used for --resume on revision
  captainNotes: string | null;        // feedback you add on approve/revise

  // --- generic extension point ---
  metadata: Record<string, unknown> | null;
  // Conventions on metadata:
  //   metadata.promptSnapshot : string        — the exact prompt the worker sent (observability)
  //   metadata.extraOutputs   : {label,path}[] — extra artifacts to surface on the card
  //   metadata.autoMode       : boolean        — if true, worker auto-completes instead of needs_review
  //   metadata.codexModel     : string         — codex model override (engine === 'codex' only); unset → codex config default

  // --- pipeline join (Layer 2; null for standalone tasks) ---
  pipelineId: string | null;          // which pipeline definition
  pipelineRunId: string | null;       // which run (row in pipeline-runs.json)
  pipelineStage: string | null;       // which stage id

  // --- timestamps ---
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
```

**Defaults `createTask` fills:** `status: 'pending'`, `priority: 3`, `engine: 'claude'`, `model: 'sonnet'`, `acceptanceCriteria: []`, `claudeNotes: ''`, `null` for the rest; `createdAt`/`updatedAt` stamped server-side. (Note: `createTask` accepts a `status` override, so callers can seed a non-pending task.)

**Engines.** A task runs under one of two CLIs, chosen by `engine`. `'claude'` (default) preserves all spine behavior. `'codex'` runs OpenAI's `codex exec` headless instead (see `02-worker-system.md` §6). Everything else — the four statuses, the claim/finalize state machine, deliverables, the review gate — is engine-agnostic: only the spawn differs. **To make codex the default for new tasks,** flip `createTask`'s default to `engine: input.engine ?? 'codex'` (and the create form's initial engine); the worker already runs whatever `engine` each task carries.

**Selection rule:** the worker claims the `pending` task with the lowest `priority`, breaking ties by oldest `createdAt`. A task whose `parentTaskId` points at a task still in `pending`/`in_progress` is skipped (blocked) until the parent advances.

### data.ts update rules (correctness-critical)

`updateTask` is a PATCH that spreads `updates` over the previous task, with these guarantees:

- **`metadata` is shallow-merged, never replaced.** When `updates.metadata` is provided, the result is `{ ...prev.metadata, ...updates.metadata }`. Callers PATCH only the keys they own, so keys accumulate (e.g. a card branch + a worker `promptSnapshot` coexist). This is a one-level merge — nested objects under a metadata key are replaced wholesale, not deep-merged. If `updates.metadata` is omitted, the previous metadata is kept untouched. This is what makes pipeline routing and observability safe.
- **`id` and `createdAt` are never overwritten** even if present in `updates`.
- **`updatedAt`** is stamped on every update.
- **`startedAt`** is stamped only on the first transition into `in_progress` (when `prev.startedAt` is null).
- **`completedAt`** is stamped whenever `updates.status === 'completed'`.

Keep the `Task` interface stable; put per-feature data in `metadata`.

### Config schemas

**`config/paths.json`** — the single source of truth for external paths. Actual shape (minimal: `projects`, `knowledgeBase`, `outputs`):

```json
{
  "projects": {
    "command-center": {
      "path": "/home/romij/claude_accessible/command-center",
      "defaultBranch": "main"
    }
  },
  "knowledgeBase": "/home/romij/notes",
  "outputs": "workers/workspace/outputs"
}
```

The rule: *every* absolute path the system needs lives here, and slash commands read it instead of hardcoding. Adding a project is adding an entry here, not a code change.

**`dashboard/data/cron-config.json`** — the worker switch:

```json
{
  "enabled": true,
  "intervalMinutes": 5,
  "lastRun": "2026-06-01T17:15:01Z",
  "lastTaskId": "task-1780332999345-d6mjom"
}
```

The Settings page writes this (`PUT /api/cron-config`); `dashboard/lib/cron.ts` reads `intervalMinutes` to install/remove the crontab line. The worker may transiently add `cooldownUntil` / `cooldownReason` keys when it detects a provider rate-limit, and clears them when the cooldown elapses. Full detail in `07-config-and-cron.md`.

### Build order

Build in sequence. Get each step working before the next. Do not build Layer 2 until the spine closes the loop.

1. **`config/paths.json`.** Config first.
2. **Dashboard skeleton** (`03-dashboard.md`): Next.js on 18424, `tasks.json` + `data.ts`, `GET/POST/PATCH /api/tasks`, the `/tasks` page with create form and status filters. You can now create and see tasks.
3. **`workers/run-worker.sh`** (`02-worker-system.md`): lock, claim the highest-priority pending task, spawn Claude with a slash command, write a deliverable, set `needs_review`. Run it once by hand.
4. **Your first slash command** (`04-slash-commands.md`): write one `worker/*.md`, create a task that uses it, run the worker, watch it land in `needs_review`, approve it. **The loop is now closed** — the milestone.
5. **Cron toggle** (`07-config-and-cron.md`): `cron.ts` + the Settings page. The worker now runs itself every N minutes.
6. **Observability** (`06-observability.md`): `metadata.promptSnapshot` + session capture + the per-agent prompt/output view.
7. **Pipelines** (`05-pipelines.md`): `config/pipelines/`, the Zod schema, the one engine, the `/pipelines` view. Then install `/setup-pipeline` and author your first multi-stage pipeline.

Steps 1–4 are the spine and the point of the first sitting. Everything after is earned.

---

## Cross-references

- `00-system-map.md` — the whole system, the loop, the glossary, the invariants.
- `02-worker-system.md` — the worker loop, claim/finalize, prompt assembly, failure handling.
- `03-dashboard.md` — pages, API route handlers, the review card.
- `04-slash-commands.md` — authoring a `worker/*` slash command.
- `05-pipelines.md` — the pipeline engine, schema, and run records.
- `06-observability.md` — prompt snapshot + session capture views.
- `07-config-and-cron.md` — cron install + the Settings toggle.
