# Dashboard

> The **See** half of the Command Center. A Next.js (app-router) app on `http://localhost:18424` that lets the Captain create tasks, watch them move through the four statuses, review the output inline, and toggle the worker. The flat JSON files under `dashboard/data/` are the database — the same files the worker reads and writes. This spec assumes the Task object and directory layout from `01-foundation.md`. Build this before the worker (build order step 2).

---

## What

The dashboard is the Captain's **See** surface. It is the one screen where the Captain works, and it does four jobs:

- **Task list + statuses** — every task, four filter tabs (All / Pending / In Progress / Needs Review / Completed) with live counts, polled every 30s so worker-driven status changes appear without a reload.
- **Create-task form** — `title`, `description`, `priority`, `model`, `slashCommand`, `acceptanceCriteria`. The server fills every other field.
- **The `needs_review` bin** — not a separate page; it is the task list filtered to `status === 'needs_review'`. Each `TaskCard` carries the review controls (Approve / Revise) and renders the deliverable inline.
- **Pipeline view + Settings** — `/pipelines` lists pipeline definitions and runs and can start a manual run; `/settings` is the worker on/off + interval toggle that drives the real crontab.

It reads and writes tasks **only through its own API** (`dashboard/app/api/`). That API is the single write path that both the UI and the worker share — the worker PATCHes task status/notes over HTTP, never touching the JSON files directly. There is one module — `lib/data.ts` — that touches `tasks.json`, guarded by a file lock.

**Stack:** Next.js 15 (app router) + React 19 + TypeScript + Tailwind, `react-markdown` for inline doc rendering, `zod` available. Flat JSON storage, no database. Port `18424` (`"dev": "next dev -p 18424"`, `"start": "next start -p 18424"` in `dashboard/package.json`).

---

## Where

Every path below is verified to exist under `dashboard/`. (The spec's directory tree must not list files that aren't there; this table is the authoritative inventory of what the dashboard ships.)

### Pages (`app/`)

| File | What it is |
|------|------------|
| `app/page.tsx` | Root `/` — server component that `redirect('/tasks')`. There is no content here. |
| `app/layout.tsx` | Root layout (HTML shell + global CSS import). |
| `app/globals.css` | Tailwind base styles. |
| `app/tasks/page.tsx` | The spine: task list + create form + needs-review bin, all one client page. Also surfaces the worker rate-limit cooldown banner (reads `/api/cron-config`). |
| `app/pipelines/page.tsx` | Pipeline view (Layer 2) — lists definitions and runs, polls every 10s, can POST a manual run. Detail in `05-pipelines.md`. |
| `app/settings/page.tsx` | Worker on/off + interval; "last run" liveness. Detail in `07-config-and-cron.md`. |

There is **no separate needs-review page** — it is the `/tasks` list filtered to `needs_review`, with review controls on each card.

### API routes (`app/api/`)

All routes go through `lib/data.ts` (for tasks) or read files directly (for outputs/sessions/commands). None touch `tasks.json` directly.

| Route | Verbs | What it does |
|-------|-------|--------------|
| `app/api/tasks/route.ts` | `GET`, `POST` | `GET` returns the sorted list (priority asc, then `createdAt` desc); `POST` creates a task (server fills all defaults). |
| `app/api/tasks/[id]/route.ts` | `GET`, `PATCH`, `DELETE` | The card and the worker both PATCH here. On a PATCH to `completed` it fires the pipeline hook `onTaskCompleted` (best-effort; never breaks the response). `404` on unknown id. |
| `app/api/cron-config/route.ts` | `GET`, `PUT` | `GET`/`PUT` the worker switch. `PUT` persists `{enabled, intervalMinutes}` (worker-owned `lastRun`/`lastTaskId` untouched) **and reconciles the real crontab** via `installCron`/`removeCron`. |
| `app/api/files/[...path]/route.ts` | `GET` only | Serves a deliverable file for the card, with a traversal guard (see How). **GET-only — there is no PUT, so the dashboard is view-only for outputs.** |
| `app/api/sessions/[taskId]/route.ts` | `GET` only | Reads `workers/workspace/sessions/{taskId}.json` for the Agent → Output tab; `404` when no session yet. |
| `app/api/slash-commands/route.ts` | `GET` only | Lists `worker/<name>` entries by reading `~/.claude/commands/worker/*.md`; returns `[]` if the dir is missing. Backs the `TaskForm` dropdown. |
| `app/api/pipelines/route.ts` | `GET` only | Lists pipeline definitions (derived at runtime from `config/pipelines/*.json`). |
| `app/api/pipeline-runs/route.ts` | `GET`, `POST` | `GET` lists runs newest-first; `POST {pipelineId, input?}` starts a manual run — `input` is an optional per-run prompt woven into the first stage (`400` if `pipelineId` missing/unknown, or `input` present but not a string). Detail in `05-pipelines.md`. |
| `app/api/pipeline-runs/[id]/route.ts` | `GET` only | One run; `404` if unknown. |

### Components (`components/`)

| File | What it is |
|------|------------|
| `components/TaskForm.tsx` | Create-task form. Fetches the slash-command list from `/api/slash-commands` and POSTs a `Partial<Task>` to `/api/tasks`. |
| `components/TaskCard.tsx` | The review surface: collapsed row + expanded panel, inline file render, review controls, and the Agent view (Prompt/Output tabs). Includes the internal `SessionView` component. |

### Lib (`lib/`)

| File | What it is |
|------|------------|
| `lib/types.ts` | The canonical `Task`, `TaskStatus`, `ModelId` types (mirrors `01-foundation.md` §4). |
| `lib/data.ts` | The **only** module that reads/writes `tasks.json`: `getTasks` / `getTask` / `createTask` / `updateTask` / `deleteTask`. |
| `lib/file-mutex.ts` | In-process promise-chain mutex (keyed by absolute path) + atomic write (tmp + rename). |
| `lib/utils.ts` | `generateId()` → `"task-{timestamp}-{random}"`. |
| `lib/cron.ts` | `installCron` / `removeCron` — reconciles the real crontab (used by `cron-config` route; detail in `07-config-and-cron.md`). |
| `lib/pipelines.ts`, `lib/pipelines.mjs` | Pipeline definitions loader (`listPipelines`) and types (Layer 2 — `05-pipelines.md`). |
| `lib/pipeline-runs.ts` | Pipeline-run store (`getRuns` / `getRun`) over `data/pipeline-runs.json` (Layer 2). |
| `lib/pipeline-engine.ts` | Pipeline progression: `onTaskCompleted`, `createRunAndSeedFirst` (Layer 2). |

### Data (`data/`) — the database

| File | What it is |
|------|------------|
| `data/tasks.json` | The queue. |
| `data/cron-config.json` | Worker switch + worker-owned liveness/cooldown keys. |
| `data/pipeline-runs.json` | Pipeline run records (Layer 2). |

---

## How — the rules that matter

### Tasks flow through the API; never hand-edit the data files

`lib/data.ts` is the single write path. Every read-modify-write runs inside the file lock; pure reads skip the lock (a single `readFile` is atomic enough, and unblocked reads keep the UI snappy). The API routes are thin wrappers over `data.ts`; the worker hits the same routes over HTTP. Do not edit `data/*.json` by hand — you will race the lock and the worker.

Key `data.ts` behaviors:

- `createTask` stamps `id` + `createdAt`/`updatedAt`, sets `status='pending'` by default, and fills every field default. The form sends only what the Captain typed.
- `updateTask` **merges** `metadata` (never replaces — a card branch and the worker's `promptSnapshot` must coexist), refuses to overwrite `id`/`createdAt`, stamps `updatedAt`, and sets `startedAt`/`completedAt` on the matching status transitions.
- `deleteTask` filters the task out and atomic-writes the rest.

`file-mutex.ts` keeps the race honest: the worker and the UI write `tasks.json` concurrently, so two read-modify-write cycles would otherwise clobber each other and lose tasks. KEEP THIS FILE. The dashboard is a single Next.js process, so an in-process lock suffices — no cross-process file lock. Reentrancy is NOT supported: never call `withFileLock` on the same path from inside a lock on that path; compose into one critical section.

### The review controls: approve vs. revise (verified in `TaskCard.tsx`)

The card offers review controls **only when `status === 'needs_review'`**. Both actions PATCH `tasks/[id]`:

- **Approve** → reveals an optional `captainNotes` textarea → `PATCH { status: 'completed', captainNotes }`.
- **Revise** → reveals a notes textarea → `PATCH { status: 'pending', claudeNotes: '[REVISION REQUESTED]\n' + notes }`. The worker detects that literal prefix and `--resume`s the prior session to refine the existing output (see `01-foundation.md` §3).

```tsx
const patch = (b: Partial<Task>) =>
  fetch(`/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  }).then(onChanged);

const approve = () => patch({ status: 'completed', captainNotes });
const revise  = () => patch({ status: 'pending', claudeNotes: `[REVISION REQUESTED]\n${reviseNotes}` });
const reopen  = () => patch({ status: 'pending' }); // shown on completed cards
```

A `completed` card shows a single **Reopen** button → `PATCH { status: 'pending' }`. **Allowed transitions** (the card never offers anything outside this table; the worker owns the rest):

| From | Captain may set | Notes |
|------|-----------------|-------|
| `pending` | *(nothing)* | worker-only — the queue claims it |
| `in_progress` | *(nothing in the card)* | the worker sets `needs_review`/`completed` |
| `needs_review` | `completed` (Approve), `pending` (Revise) | the two main buttons |
| `completed` | `pending` (Reopen) | reopen for another pass |

### The card is a generic render target (view-only outputs)

The needs-review bin is the one place the Captain works, so the card has to **hold anything** Claude produces without the `Task` interface growing a field per content type. Two hooks carry it: `metadata` and `completionFile`.

- **`metadata.extraOutputs` — `{label, path}[]`.** Rendered as open links through `/api/files/<path>`, zero special-casing.
- **Inline file render.** On expand, the card fetches `completionFile` via `/api/files/<path>` and renders by extension: `.md` as a `react-markdown` doc, `.diff`/`.patch` as a `<pre>` diff block, `.png`/`.jpg` as an `<img>`, anything else as plain `<pre>`. This is why the Captain rarely leaves the bin — the deliverable is *in the card*.
- **Extend with one branch.** A new content type is one `metadata`-keyed branch in the expanded panel — no schema change. The shipped example is `metadata.kind === 'draft'`, which adds a copy-to-clipboard block.

#### Stage-specific preview/action extension (slide-review style)

To add bespoke behavior like `Preview Presentation` or `Host Worktree Preview`, add one guarded branch in `components/TaskCard.tsx`:

- Check `task.stage` (or a metadata flag) and render the action block only for that stage.
- Post to a dedicated route (example: `/api/slide-review-preview/${task.id}`) when Captain clicks.
- Read resulting preview metadata back from `task.metadata` (`previewUrl`, `worktreePreviewUrl`, `worktreePreviewPort`) for display.
- Keep behavior behind feature metadata instead of changing the `Task` type.

That is the minimum extension path for custom action buttons, preview launchers, and related metadata-driven links in the new command center.

The card also renders, when present: the description, acceptance criteria (read-only checkboxes), and `claudeNotes`.

**Outputs are view-only.** The files route (`app/api/files/[...path]/route.ts`) exposes **`GET` only** — there is no PUT/POST. The dashboard renders and serves deliverables; it never edits or saves them back. Same for the sessions route.

### The Agent view — Prompt / Output tabs (verified in `TaskCard.tsx`)

The expanded panel always shows an Agent view with two tabs:

- **Prompt** — renders `task.metadata.promptSnapshot` (the exact prompt the worker sent), or "No prompt snapshot recorded."
- **Output** — the internal `SessionView` fetches `/api/sessions/{taskId}` and renders the captured run: NDJSON stream entries become text blocks, `tool_use`, `tool_result`, and a final `result`; a single-object capture falls back to `.result` or the raw text. It also shows `claudeNotes` and a link to `completionFile`. "No session yet." when the file is absent. (Detail in `06-observability.md`.)

### The file-serving route is GET-only with a traversal guard

`files/[...path]/route.ts` resolves the requested segments against `ALLOWED_ROOT = resolve(process.cwd(), '..')` (the repo root; outputs live under `workers/workspace`), and rejects with `403` anything that escapes the root. Each type gets a `Content-Type` from a small MIME map (`.md`, `.txt`, `.json`, `.diff`, `.patch`, `.png`, `.jpg`); unknown → `application/octet-stream`. Missing file → `404`.

```ts
const ALLOWED_ROOT = path.resolve(process.cwd(), '..');
const filePath = path.resolve(ALLOWED_ROOT, ...segments);
if (!filePath.startsWith(ALLOWED_ROOT)) {
  return NextResponse.json({ error: 'Access denied' }, { status: 403 }); // no traversal out
}
```

### Task sorting and polling

`GET /api/tasks` sorts priority ascending, then `createdAt` descending, so the page renders as returned. The `/tasks` page polls `GET /api/tasks` (and `/api/cron-config`) on mount and every 30s via `setInterval` — this is how a task appears in `needs_review` without a reload. Filtering and counts are client-side over the already-fetched list.

### The cron-config route already wires the crontab

Unlike a deferred stub, `cron-config/route.ts` already drives the real crontab: on `PUT`, if the worker was turned on (or the interval moved) it calls `installCron(intervalMinutes)`; if turned off it calls `removeCron()`. It persists `{enabled, intervalMinutes}` and leaves worker-owned `lastRun`/`lastTaskId`/cooldown keys alone. The Settings page is the UI; the cooldown banner on `/tasks` reads `cooldownUntil`/`cooldownReason` from the same file. Full crontab semantics: `07-config-and-cron.md`.

---

## Build checklist (this spec)

1. Next.js app on port `18424`, Tailwind wired, `lib/types.ts` from `01-foundation.md` §4.
2. `file-mutex.ts`, then `data.ts` (`getTasks` / `getTask` / `createTask` / `updateTask` / `deleteTask`), then `utils.ts`.
3. `tasks/route.ts` + `tasks/[id]/route.ts` + `files/[...path]/route.ts` + a `cron-config/route.ts` + `slash-commands/route.ts` + `sessions/[taskId]/route.ts`.
4. `TaskForm.tsx`, `TaskCard.tsx` (incl. the Agent Prompt/Output tabs), the `/tasks` page with the four filter tabs and 30s polling, `app/page.tsx` redirect, `app/layout.tsx`.
5. `/pipelines` and `/settings` pages and the pipeline routes/lib (filled in by specs 05 and 07).

When you can create a task in the form, see it appear `pending`, render its output inline, and PATCH it through the statuses from the card, the **See** half is done. Next: `02-worker-system.md` to build the **Do** half that fills the needs-review bin.
