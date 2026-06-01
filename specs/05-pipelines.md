# Pipelines — the engine and the 4-tier model

> **The one source of truth for pipelines.** A pipeline is a chain of stages in one JSON file. The **engine** — and only the engine — evaluates gates and seeds next-stage tasks. The worker never progresses pipelines. This spec gives you the file location, the canonical Zod shape, the single engine that runs it, and a four-tier tutorial that teaches the whole model one concept at a time. Build this *after* the spine closes the loop (foundation → worker → dashboard → slash command). Layer 2.

---

## What

A **pipeline** is a chain of **stages** defined in exactly one JSON file: `config/pipelines/<id>.json`. Each stage runs one worker slash command, then a **gate** decides what happens when that stage's task finishes — progress now (`auto`), hold for the Captain (`review`), or run a script (`test`). `next` links one stage to the next; omit it on the terminal stage. **One file, one schema, one engine.**

The engine (`dashboard/lib/pipeline-engine.ts`) is the **only** code that evaluates gates and seeds next-stage tasks. Drawing the line precisely:

| Concern | Owner |
|---------|-------|
| Running Claude on a task and setting that task's **status** (the "spine default") | **Worker** (`workers/run-worker.sh`) |
| Evaluating a gate, seeding the next stage's task, running test gates, healing, completing/failing the run | **Engine** (`dashboard/lib/pipeline-engine.ts`) |
| Approving a `review`-gate task so its stage can progress | **Captain** (via the dashboard → tasks PATCH API → engine) |

The worker never reads `config/pipelines/`, never seeds a task, never touches `pipeline-runs.json`. It runs one task and sets one status. Everything about "what comes next" lives in the engine. This is the system invariant — *the script owns task status, the engine owns progression* — made literal: two responsibilities, two owners, no overlap.

The coupling that makes this work: when the engine seeds a child task it stamps **`metadata.autoMode = (gate.type !== 'review')`**. The worker reads that flag and chooses its spine-default status from it (`true → completed`, `false → needs_review`). So the engine's gate type silently steers the worker's status, and the worker stays ignorant of pipelines. (See §"Who sets status".)

**The anti-pattern you are avoiding.** A pipeline whose definition is smeared across three places — a JSON schema file, a TypeScript constant listing the stages, and a shell `case` statement that hardcodes "after stage A run stage B." Three copies of one truth. They drift the first time someone edits one and forgets the others, and then the dashboard shows one thing while the worker does another. We refuse that. **One file. One schema. One engine.** Everything reads the file; nothing re-encodes it.

```
config/pipelines/content-draft.json   ← THE definition (you write this)
        │
        ├─ validated by ─────────────► dashboard/lib/pipelines.mjs   (Zod schema, canonical shape)
        ├─ typed by ─────────────────► dashboard/lib/pipelines.ts    (z.infer re-export + loaders)
        ├─ listed by ────────────────► GET /api/pipelines            (reads the dir, no constant)
        └─ executed by ──────────────► dashboard/lib/pipeline-engine.ts  (the ONLY progression code)
```

---

## Where

Every file below exists in the repo. Verify any path before trusting a claim about it.

| Path | Role |
|------|------|
| `config/pipelines/<id>.json` | The pipeline definitions you author. Currently the directory ships exactly one: `config/pipelines/content-draft.json`. To add a pipeline you drop a JSON file here — that is the whole act of creation. |
| `dashboard/lib/pipelines.mjs` | The **canonical Zod schema** for a pipeline definition. ESM JavaScript so plain Node (the validator) can load it without a TypeScript runtime. The one and only definition of what a pipeline *is*. |
| `dashboard/lib/pipelines.ts` | TypeScript surface. Re-exports the schemas from `.mjs`, derives static types via `z.infer<>`, and provides the filesystem helpers `loadPipeline(id)` and `listPipelines()`. Defines **no schemas** of its own. |
| `dashboard/lib/pipeline-engine.ts` | The **only** progression code: evaluates gates, seeds next-stage tasks, runs test gates, heals, completes/fails runs. |
| `dashboard/lib/pipeline-runs.ts` | The data accessor (CRUD) for run records in `dashboard/data/pipeline-runs.json`. Owns the `PipelineRun` / `StageState` / `PipelineEvent` shapes and server-stamps every timestamp. |
| `dashboard/app/api/pipelines/route.ts` | `GET /api/pipelines` — lists pipelines by reading the directory at runtime (no registry constant). |
| `dashboard/app/api/pipeline-runs/route.ts` | `GET` lists runs (newest first); `POST { pipelineId, input? }` starts a run via `createRunAndSeedFirst` (the optional `input` is a per-run prompt for the first stage). |
| `dashboard/app/api/pipeline-runs/[id]/route.ts` | `GET /api/pipeline-runs/[id]` — one run, 404 if unknown. |
| `dashboard/app/api/tasks/[id]/route.ts` | The tasks PATCH route. **Calls the engine** (`onTaskCompleted`) when a task reaches `status === 'completed'`. |
| `scripts/validate-pipelines.sh` | Validates every `config/pipelines/*.json` against the Zod schema and confirms every referenced command file exists. |
| `scripts/trigger-pipeline.sh` | Starts a run by POSTing `{ pipelineId }` to `/api/pipeline-runs`. The concrete command a cron pipeline runs. |
| `dashboard/data/pipeline-runs.json` | The run database — an array of `PipelineRun` records. |

---

## How

### 1. The one-source-of-truth principle

A pipeline is defined in **exactly one place**: `config/pipelines/<id>.json`.

- The **shape** of that file is the Zod schema in `dashboard/lib/pipelines.mjs`. This spec restates the shape so you can read it, but the Zod schema is canonical — when they disagree, the schema wins and this spec is updated.
- The dashboard's list of pipelines is **derived at runtime** by `listPipelines()` reading `config/pipelines/*.json`. There is **no hand-maintained registry constant** — no array of pipeline names in TypeScript, no second copy anywhere. To add a pipeline you drop a JSON file in the directory.
- `dashboard/lib/pipelines.ts` re-exports the schema, derives the static TypeScript types with `z.infer<>`, and adds the two filesystem loaders. It defines no shapes of its own.

### 2. The schema (restated — Zod is canonical)

A pipeline is an `id`, a `name`, a `trigger`, and an ordered set of `stages`. Each stage runs one worker slash command, then a **gate** decides whether to progress, wait for the Captain, or test the output. `next` links one stage to the next; omit it on the final stage.

```
PipelineDef (strict object)
  id           string   kebab-case, MUST equal the filename without .json   [required]
  name         string   human label shown in the dashboard                  [required]
  description  string                                                        [optional]
  trigger      { type: "cron" | "manual", cron?: string }                    [required]
  stages       Stage[]  at least one                                         [required]

Stage (strict object)
  id           string   unique within the pipeline                          [required]
  label        string   human label for the stage                           [optional]
  command      string   "worker/<name>" — the slash command this stage runs [required]
  gate         Gate     what happens when the stage's task finishes          [required]
  inputs       string[] upstream stage ids whose deliverable this stage reads [optional; data flow — see §2.2]
  next         string   id of the stage to run next                         [optional; omit on the terminal stage]

Gate (discriminated union on `type`)
  { type: "auto" }                              progress immediately
  { type: "review", instructions?: string }     hold for Captain approval first
  { type: "test", command: string,              run a script; pass progresses, fail heals
    onFail: { heal: "worker/<name>",
              maxRetries: int >= 0,
              thenEscalate: "review" } }
```

**superRefine (cross-field rules the schema enforces):**
1. Stage `id`s are unique within the pipeline.
2. Every `next` reference points at a declared stage `id`.
3. Every `inputs` entry points at a declared stage `id`, is not the stage itself, and names a stage that runs **earlier** in the chain (an ancestor in the `next` walk from the first stage).

#### 2.1 The Zod source — `dashboard/lib/pipelines.mjs`

Authored as ESM JavaScript so plain Node scripts (the validator) can load it without a TypeScript runtime. **This is the canonical shape — the one and only definition of what a pipeline is.** The `/setup-pipeline` skill *quotes* this schema in its instructions so it authors conforming JSON, then validates its output against *this* file via `scripts/validate-pipelines.sh`. It does not keep its own copy — there is one schema, here.

```js
// dashboard/lib/pipelines.mjs
// Canonical Zod schema for pipeline definitions. ONE schema, in ONE file.
// dashboard/lib/pipelines.ts re-exports these and derives TS types via z.infer.
import { z } from 'zod';

export const TriggerSchema = z
  .object({
    type: z.enum(['cron', 'manual']),
    cron: z.string().min(1).optional(), // required in practice when type === 'cron'
  })
  .strict();

export const AutoGateSchema = z
  .object({ type: z.literal('auto') })
  .strict();

export const ReviewGateSchema = z
  .object({
    type: z.literal('review'),
    instructions: z.string().optional(),
  })
  .strict();

export const TestGateSchema = z
  .object({
    type: z.literal('test'),
    command: z.string().min(1),
    onFail: z
      .object({
        heal: z.string().min(1),         // "worker/<name>"
        maxRetries: z.number().int().nonnegative(),
        thenEscalate: z.literal('review'),
      })
      .strict(),
  })
  .strict();

export const GateSchema = z.discriminatedUnion('type', [
  AutoGateSchema,
  ReviewGateSchema,
  TestGateSchema,
]);

export const StageSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    command: z.string().min(1),          // "worker/<name>"
    gate: GateSchema,
    inputs: z.array(z.string().min(1)).optional(), // data flow: upstream stage ids this stage reads
    next: z.string().min(1).optional(),  // omit on the terminal stage
  })
  .strict();

export const PipelineDefSchema = z
  .object({
    id: z.string().min(1),               // MUST equal the filename without .json
    name: z.string().min(1),
    description: z.string().optional(),
    trigger: TriggerSchema,
    stages: z.array(StageSchema).min(1),
  })
  .strict()
  .superRefine((def, ctx) => {
    // 1. Stage ids unique.
    const seen = new Set();
    for (const [i, stage] of def.stages.entries()) {
      if (seen.has(stage.id)) {
        ctx.addIssue({ code: 'custom', path: ['stages', i, 'id'],
          message: `duplicate stage id "${stage.id}"` });
      }
      seen.add(stage.id);
    }
    // 2. Every `next` points at a declared stage id.
    const ids = new Set(def.stages.map((s) => s.id));
    for (const [i, stage] of def.stages.entries()) {
      if (stage.next !== undefined && !ids.has(stage.next)) {
        ctx.addIssue({ code: 'custom', path: ['stages', i, 'next'],
          message: `unknown stage id "${stage.next}"` });
      }
    }
    // 3. Every `inputs` entry names a declared stage that runs EARLIER in the
    //    chain (never itself, never a later stage). Run order = the `next` walk.
    const order = new Map();
    {
      const byId = new Map(def.stages.map((s) => [s.id, s]));
      let cur = def.stages[0]; let pos = 0; const walked = new Set();
      while (cur && !walked.has(cur.id)) {
        walked.add(cur.id); order.set(cur.id, pos++);
        cur = cur.next !== undefined ? byId.get(cur.next) : undefined;
      }
    }
    for (const [i, stage] of def.stages.entries()) {
      if (stage.inputs === undefined) continue;
      for (const [j, inId] of stage.inputs.entries()) {
        if (!ids.has(inId)) {
          ctx.addIssue({ code: 'custom', path: ['stages', i, 'inputs', j],
            message: `unknown stage id "${inId}"` }); continue;
        }
        if (inId === stage.id) {
          ctx.addIssue({ code: 'custom', path: ['stages', i, 'inputs', j],
            message: `stage "${stage.id}" cannot list itself as an input` }); continue;
        }
        const here = order.get(stage.id); const there = order.get(inId);
        if (here !== undefined && there !== undefined && there >= here) {
          ctx.addIssue({ code: 'custom', path: ['stages', i, 'inputs', j],
            message: `input "${inId}" does not run before stage "${stage.id}"` });
        }
      }
    }
  });
```

```ts
// dashboard/lib/pipelines.ts — TypeScript surface. Re-export only; defines NO shapes.
// Plus two filesystem helpers (loadPipeline / listPipelines) over config/pipelines/*.json.
import fs from 'fs';
import path from 'path';
import type { z } from 'zod';
import {
  PipelineDefSchema, StageSchema, GateSchema,
  AutoGateSchema, ReviewGateSchema, TestGateSchema, TriggerSchema,
} from './pipelines.mjs';

export {
  PipelineDefSchema, StageSchema, GateSchema,
  AutoGateSchema, ReviewGateSchema, TestGateSchema, TriggerSchema,
};

export type Trigger = z.infer<typeof TriggerSchema>;
export type Gate = z.infer<typeof GateSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type PipelineDef = z.infer<typeof PipelineDefSchema>;

export function parsePipelineDef(input: unknown): PipelineDef {
  return PipelineDefSchema.parse(input); // throws ZodError on bad input
}

// Next.js runs with cwd = dashboard/, so the repo root is one level up.
const PIPELINES_DIR = path.join(process.cwd(), '..', 'config', 'pipelines');

// Read + parse config/pipelines/<id>.json. Throws if missing or invalid.
export function loadPipeline(id: string): PipelineDef {
  const file = path.join(PIPELINES_DIR, `${id}.json`);
  const raw = fs.readFileSync(file, 'utf-8');
  return parsePipelineDef(JSON.parse(raw));
}

// Read the dir, parse every *.json, keep the valid ones, skip .schema.json.
// Never throws on a missing dir or a bad file — returns what it can.
export function listPipelines(): PipelineDef[] { /* … */ }
```

`.strict()` everywhere is deliberate: an unknown field is a typo, and a typo is a bug. The schema rejects it instead of silently ignoring it.

### 2.2 Data flow between stages — `inputs`

`next` is **control flow** (what runs next). `inputs` is **data flow** (what a stage *reads*). They are independent axes, and conflating them is the failure this section prevents.

**The default.** When the engine seeds a stage, it hands that stage the *immediately-preceding* stage's deliverable — as `metadata.previousCompletionFile` and a `Previous stage output:` line in the task description. A straight chain needs nothing else, so most stages declare no `inputs` at all. This is the original, unchanged handoff.

**The problem the default cannot solve.** A chain is a single hop: stage 4 receives stage 3's output and *only* stage 3's. If stage 4 needs **stage 2's** exact deliverable, the default never hands it over — stage 2's output still exists on disk, but nothing routes it forward, and the stage-4 agent has no reliable handle to find it. Carrying the data through every intermediate stage ("accumulation") is brittle and lossy.

**The fix — explicit `inputs`.** A stage may declare `inputs: ["<earlier-stage-id>", ...]`. For each id, the engine resolves that stage's deliverable (the `completionFile` of its most-recent completed task, read off the run record) and hands them forward **by name**:

- in the task description, under an `Inputs from prior stages:` block (`- <stageId>: <path>` per line), and
- in `metadata.inputs` — a `{ stageId: path }` map.

So stage 4 declaring `inputs: ["research"]` receives `research`'s deliverable regardless of how many stages sit between them. The resolution is **fully script-derived**: the consuming agent reports nothing and the upstream agent does nothing special — the engine reads the path from the run record, exactly as the default handoff does. (`inputs` is *additive* to the default: a stage that declares `inputs` still also receives `previousCompletionFile` for its immediate predecessor. Read by name; ignore what you don't need.)

**Constraints (schema-enforced, §2 rule 3).** An `inputs` entry must name a declared stage, may not be the stage itself, and must run **earlier** in the chain — the engine can only hand forward a deliverable that already exists when the stage is seeded. The first stage therefore cannot declare `inputs`.

**Resolution detail.** A stage's deliverable is its `completionFile` — one file (the worker picks a recognizable primary, else the first file). To read *other* files the upstream stage wrote, `dirname` the handed path and read the siblings in that `outputs/{task-id}/` directory.

**Where it shows.** The `/pipelines` dashboard renders the data flow alongside the control-flow chain: each stage's sources as `<a> + <b> → <stage>`, marking default (previous-stage) edges distinctly from declared `inputs`. The wiring is legible without opening the JSON.

`/setup-pipeline` asks about this explicitly (its question 3) and writes `inputs` only where a stage genuinely needs a non-adjacent output.

### 3. The 4-tier tutorial

Each tier adds **exactly one** new concept. Build them in order; you will understand the whole engine by Tier 4. **These four examples are illustrative — they are not shipped files.** The repo ships exactly one pipeline, `config/pipelines/content-draft.json` (a draft → review chain that combines Tier 2's `next` with Tier 3's `review` gate). Swap in your own work.

#### Tier 1 — single-stage cron auto

The smallest possible pipeline: one stage, fires on a schedule, completes itself. A "daily report" that runs every morning.

```json
{
  "id": "daily-report",
  "name": "Daily Report",
  "description": "Generate the morning report at 9am.",
  "trigger": { "type": "cron", "cron": "0 9 * * *" },
  "stages": [
    { "id": "report", "label": "Write report", "command": "worker/daily-report", "gate": { "type": "auto" } }
  ]
}
```

Field by field:
- `id` — `"daily-report"`, equals the filename `daily-report.json`. The join key everywhere.
- `name` — what the dashboard shows.
- `trigger.type: "cron"` with `cron: "0 9 * * *"` — a scheduled tick at 09:00 daily runs `scripts/trigger-pipeline.sh daily-report`, which creates a run and the first stage's task. (Cron install: see `07-config-and-cron.md`.)
- `stages[0].command: "worker/daily-report"` — the slash command the worker runs.
- `gate: { type: "auto" }` — when the task finishes, progress immediately. There is no `next`, so this stage is **terminal**: the run completes.

**Execution trace.** 09:00 tick → `trigger-pipeline.sh` POSTs to the API → engine creates a run + a `report` task (`status: pending`, `metadata.autoMode: true`) → worker claims it, runs `worker/daily-report`, writes the deliverable → because `autoMode` is true the worker sets the task `completed` → the tasks PATCH route fires `onTaskCompleted`, which (gate is `auto`, not `review`) dispatches to `onStageComplete` → gate `auto`, no `next` → the engine marks the **run** `completed`. No human touched it.

#### Tier 2 — multi-stage chaining with `next`

New concept: **`next`** chains stages. A "content draft" that drafts, then formats, with no human in between.

```json
{
  "id": "content-draft",
  "name": "Content Draft",
  "trigger": { "type": "manual" },
  "stages": [
    { "id": "draft",  "command": "worker/draft",  "gate": { "type": "auto" }, "next": "format" },
    { "id": "format", "command": "worker/format", "gate": { "type": "auto" } }
  ]
}
```

`draft` has `gate auto` and `next: "format"`. When the `draft` task completes, the engine seeds a `format` task automatically (stamped `autoMode: true`, and handed the draft's deliverable via `metadata.previousCompletionFile`). `format` has no `next`, so when it completes the run is done. Two stages, both auto, zero human gates — a clean automatic chain. (The real `content-draft.json` that ships uses this `next` chaining, but its second stage is a `review` gate, not `auto` — see Tier 3.)

#### Tier 3 — the `review` gate

New concept: the **`review`** gate. The Captain approves before the next stage runs (or, on a terminal stage, before the run completes). A draft that auto-progresses, then **holds** for approval.

```json
{
  "id": "draft-and-publish",
  "name": "Draft and Publish",
  "trigger": { "type": "manual" },
  "stages": [
    { "id": "draft",   "command": "worker/draft",   "gate": { "type": "auto" }, "next": "publish" },
    { "id": "publish", "command": "worker/publish", "gate": { "type": "review", "instructions": "check tone before publishing" } }
  ]
}
```

`draft` runs and auto-progresses to `publish`. Because `publish`'s gate is `review`, the engine seeds it with **`autoMode: false`**, so when the `publish` worker finishes the worker sets the task to **`needs_review`** instead of `completed`. The engine does **nothing** at this point; the run sits at `awaiting_review`. The Captain opens the dashboard, reads the deliverable (the `instructions` string is shown as the review prompt: *"check tone before publishing"*), and clicks **Approve** — which PATCHes the task to `completed`. Only then does the route fire `onTaskCompleted` → (gate is `review`) → `onApprove`, which seeds the stage's `next`, or completes the run if terminal. `publish` is terminal here, so approval ends the run.

This is Law 1 made concrete: the human is positioned at the gate, reviewing, not doing.

#### Tier 4 — the `test` gate and healing

New concept: the **`test`** gate plus self-healing. A "build and verify" pipeline whose build is checked by a script; if the check fails, a fix worker runs and the check re-runs; after enough failed attempts it escalates to the Captain.

```json
{
  "id": "build-and-verify",
  "name": "Build and Verify",
  "trigger": { "type": "manual" },
  "stages": [
    {
      "id": "build",
      "command": "worker/build",
      "gate": {
        "type": "test",
        "command": "test -s workers/workspace/outputs/${TASK_ID}/build.txt",
        "onFail": { "heal": "worker/fix", "maxRetries": 2, "thenEscalate": "review" }
      }
    }
  ]
}
```

A `test`-gate stage is seeded with `autoMode: true` (it is not a `review` gate), so its worker sets the task `completed`. That triggers `onTaskCompleted` → `onStageComplete`, which **runs the gate command** at the repo root with `${TASK_ID}` substituted for the parent task's id:

- **pass (exit 0)** → the build is good. The engine records `gate_passed`, marks the stage `completed`, and seeds `next` (here there is none, so the run completes).
- **fail (exit ≠ 0)** → the engine records `gate_failed`, increments `healAttempts`, sets the stage and run to `healing`, and seeds a heal task that runs `worker/fix`. The heal task **keeps the same stage id** and is stamped `autoMode: true`, so when it completes it re-enters `onStageComplete` and **re-runs the same gate command**. Pass → progress. Fail again → heal again.
- **maxRetries exhausted** → once `healAttempts >= maxRetries`, the engine stops healing: it marks the stage `failed`, sets the **run** `failed`, records `escalated`, and (because `thenEscalate: "review"`) PATCHes the stage's parent task to `needs_review` with the last gate exit code in `claudeNotes`. The Captain takes over.

`maxRetries: 2` means up to two heal attempts before escalation. The gate command is the contract for "done": if you cannot write a script that checks the output, the stage should use a `review` gate instead.

### 4. The one engine — `dashboard/lib/pipeline-engine.ts`

This is the **only** code that evaluates gates and seeds next-stage tasks. **The worker never progresses pipelines.** The dashboard's tasks PATCH route calls the engine *only when a task reaches `completed`*; the engine does everything from there.

#### 4.1 Who sets status at each gate

| Step | Who | What they do |
|------|-----|--------------|
| Engine seeds a stage's task | **Engine** | Stamps `metadata.autoMode = (gate.type !== 'review')` on the child. This is the coupling that steers the worker's status. |
| Stage task finishes | **Worker** | Reads `metadata.autoMode`: `true → completed` (auto/test stages + heals), `false → needs_review` (review stages, standalone). The worker never reads the pipeline. |
| Task reaches `completed` | **tasks PATCH route** | Fires `onTaskCompleted(task)` (only on `status === 'completed'`). |
| `onTaskCompleted` | **Engine** | Loads the pipeline, finds the stage, and dispatches: gate `review` → `onApprove`; gate `auto`/`test` → `onStageComplete`. |
| `auto` gate | **Engine** (`onStageComplete`) | Records `gate_passed`, marks the stage `completed`, seeds `next` (or completes the run). |
| `test` gate | **Engine** (`onStageComplete`) | Runs the gate command; on pass seeds `next`, on fail seeds a heal task; escalates after `maxRetries`. |
| `review` gate, worker done | **Engine** (`onApprove`) | This is the *approval* path. A `review` task only reaches `completed` when the Captain approves — at which point `onApprove` records `approved`, marks the stage `completed`, and seeds `next` (or completes the run). |

The chain in one sentence: the engine's gate type decides `autoMode`; `autoMode` decides the worker's status; a `completed` status fires the engine; the engine seeds the next task. Nobody else writes pipeline state.

> **Why the route only acts on `completed`.** A `review` task sits at `needs_review` after the worker runs — the route does nothing. It is the **Captain's Approve** (which PATCHes the task to `completed`) that re-enters the route and lets `onTaskCompleted` → `onApprove` progress the run. There is no separate "approve" endpoint; approval is just a status PATCH to `completed`.

#### 4.2 The entry point + `onStageComplete`

```ts
// dashboard/lib/pipeline-engine.ts  (the ONLY progression code)

// Single entry point the tasks PATCH route calls on every completed task.
export async function onTaskCompleted(task: Task): Promise<void> {
  if (!task.pipelineRunId || !task.pipelineId) return; // not a pipeline task

  const def = loadPipeline(task.pipelineId);           // read config/pipelines/<id>.json
  const stage = def.stages.find((s) => s.id === task.pipelineStage);
  if (!stage) return;

  if (stage.gate.type === 'review') await onApprove(task);
  else await onStageComplete(task);
}

export async function onStageComplete(task: Task): Promise<void> {
  if (!task.pipelineRunId || !task.pipelineId) return;
  const def = loadPipeline(task.pipelineId);
  const stage = def.stages.find((s) => s.id === task.pipelineStage);
  if (!stage) return;

  switch (stage.gate.type) {
    case 'auto': {
      await recordEvent(task, stage.id, 'gate_passed');
      await setStageState(task, stage.id, 'completed');
      await seedNext(task, def, stage);                // seed `next`, or complete the run if terminal
      break;
    }

    case 'test': {
      const code = runShell(resolveCommand(stage.gate.command, task)); // exit 0 = pass
      if (code === 0) {
        await recordEvent(task, stage.id, 'gate_passed');
        await setStageState(task, stage.id, 'completed');
        await seedNext(task, def, stage);
      } else {
        const st = await getStageState(task, stage.id);
        const healAttempts = st?.healAttempts ?? 0;
        await recordEvent(task, stage.id, 'gate_failed', `exit ${code}`);
        if (healAttempts >= stage.gate.onFail.maxRetries) {
          await setStageState(task, stage.id, 'failed', { lastError: `exit ${code}` });
          await setRunStatus(task, 'failed');
          await recordEvent(task, stage.id, 'escalated', stage.gate.onFail.thenEscalate);
          // thenEscalate === 'review' → Captain inspects the parent task
          await updateTask(task.id, {
            status: 'needs_review',
            claudeNotes: `Test gate failed after ${stage.gate.onFail.maxRetries} heal attempt(s). Last gate exit: ${code}.`,
          });
        } else {
          await setStageState(task, stage.id, 'healing', {
            healAttempts: healAttempts + 1,            // increment BEFORE seeding the heal
            lastError: `exit ${code}`,
          });
          await setRunStatus(task, 'healing');
          await recordEvent(task, stage.id, 'heal_triggered', stage.gate.onFail.heal);
          // Re-tests the SAME stage: the heal keeps this stage id and autoMode=true.
          await seedChildTask(task.pipelineRunId!, def, stage.id, {
            command: stage.gate.onFail.heal,
            autoMode: true,
            isHeal: true,
          });
        }
      }
      break;
    }

    case 'review':
      return; // No-op here. Review progresses via onApprove, not onStageComplete.
  }
}
```

#### 4.3 `onApprove`

```ts
// Called by onTaskCompleted when a review-gate task reaches `completed`
// (i.e. the Captain approved it).
export async function onApprove(task: Task): Promise<void> {
  if (!task.pipelineRunId || !task.pipelineId) return;
  const def = loadPipeline(task.pipelineId);
  const stage = def.stages.find((s) => s.id === task.pipelineStage);
  if (!stage || stage.gate.type !== 'review') return;

  await recordEvent(task, stage.id, 'approved');
  await setStageState(task, stage.id, 'completed');
  await seedNext(task, def, stage); // seed `next`, or complete the run if terminal
}
```

#### 4.4 Seeding — `seedNext`, `seedChildTask`, `createRunAndSeedFirst`

`seedNext(task, def, stage)` follows `stage.next`. If there is a next stage it marks that stage `running`, calls `seedChildTask`, and sets the run status for the new stage (`review → awaiting_review`, else `running`), handing the just-finished stage's `completionFile` forward as `prevOutput`. If there is **no** `next`, the stage is terminal: the engine records `completed` and marks the **run** `completed`.

`seedChildTask(runId, def, stageId, opts)` is the single low-level seeder. It:

1. Creates the child task with `status: 'pending'`, `model: 'sonnet'`, and the stage's `command` as `slashCommand`.
2. **Stamps the pipeline join** on the child: `pipelineId`, `pipelineRunId`, `pipelineStage`.
3. Stamps `metadata.autoMode = opts.autoMode` (the §4.1 coupling), plus `metadata.previousCompletionFile` when a `prevOutput` was handed forward, plus `metadata.runInput` when a run `input` was handed forward (see below).
4. **Resolves this stage's declared `inputs`** (§2.2) via `resolveStageInputs(runId, def, stageId)` — for each named upstream stage id, reads the `completionFile` of its most-recent completed task off the run record — then stamps the `{ stageId: path }` map as `metadata.inputs` and appends an `Inputs from prior stages:` block to the child's `description`. Empty when the stage declares no `inputs`. Independent of `prevOutput`: a stage gets both.
5. When `opts.input` is set, appends it to the child's `description` under a `## Run input` heading. Because the worker builds its prompt from the task's `description`, this is what carries a per-run prompt to the agent — no special handling in the worker.
6. Appends the child's id to the stage's `taskIds` in the run record and pushes a `started` `PipelineEvent`. It does **not** set run/stage status — callers own that, so the heal path can keep the stage `healing` while a next-stage seed marks it `running`.

`createRunAndSeedFirst(pipelineId, trigger, input?)` is the public starter used by `POST /api/pipeline-runs`: it creates the run, marks the first stage `running`, seeds the first task (`autoMode` by the first stage's gate), and sets the run status for that stage. The optional `input` is a per-run prompt that is woven into the **first stage only** — it is the run's WHAT. Downstream stages do not receive it directly; they receive the prior stage's deliverable via `prevOutput`. A blank/whitespace-only `input` is treated as no input.

> **Stamp timestamps server-side.** The engine sets each event's `ts` and the run's `startedAt`/`completedAt` when it records them — never trusting client input. `appendEvent` overrides any client-supplied `ts`. The child task's `createdAt`/`updatedAt` are stamped by the data layer the same way.

### 5. The run record — `dashboard/data/pipeline-runs.json`

One execution of a pipeline definition is one `PipelineRun`, stored as an array element in `dashboard/data/pipeline-runs.json`. Shapes are owned by `dashboard/lib/pipeline-runs.ts`.

```ts
type RunStatus    = 'running' | 'awaiting_review' | 'healing' | 'failed' | 'completed';
type StageStatus  = 'pending' | 'running' | 'completed' | 'healing' | 'failed';

interface StageState {
  status: StageStatus;
  taskIds: string[];          // every task seeded for this stage (incl. heal tasks)
  healAttempts: number;
  lastError?: string;
}

type PipelineEventType =
  | 'started' | 'gate_passed' | 'gate_failed' | 'heal_triggered'
  | 'approved' | 'escalated' | 'completed';

interface PipelineEvent {
  ts: string;                 // ISO, ALWAYS server-stamped
  stage: string;
  type: PipelineEventType;
  detail?: string;
  taskId?: string;
}

interface PipelineRun {
  id: string;                 // "run-{timestamp}-{random}"
  pipelineId: string;         // which definition (config/pipelines/<id>.json)
  pipelineSlug: string;       // human-readable instance label (defaults to the pipeline's name)
  status: RunStatus;
  startedAt: string;          // ISO, server-stamped
  completedAt: string | null;
  trigger: { type: 'cron' | 'manual'; source?: string };
  stageState: Record<string, StageState>;
  events: PipelineEvent[];
}
```

`stageState` is the live position of the run (where each stage is, how many heals it has burned). `events` is the append-only history (what happened, when). The `/pipelines` dashboard page reads these to render run timelines. The accessor (`getRuns`, `getRun`, `createRun`, `updateRun`, `setStage`, `appendEvent`) writes through a file lock with atomic JSON writes and never overwrites `id` or `startedAt`.

### 6. Triggering

Both trigger kinds run a pipeline through the **same** entry point — `POST /api/pipeline-runs` → `createRunAndSeedFirst` — which creates one run and seeds the first stage's task `pending`. The engine drives everything after that.

- **Manual pipelines** (`trigger.type: "manual"`). The "Run" button on the `/pipelines` page opens an inline composer with an optional prompt field, then POSTs `{ pipelineId, input? }`. The API rejects a missing or unknown `pipelineId` with `400`, and an `input` that is present but not a string with `400`.
- **Cron pipelines** (`trigger.type: "cron"`). A scheduled tick runs `scripts/trigger-pipeline.sh <id>` (installed from `trigger.cron` per `07-config-and-cron.md`), which POSTs `{ pipelineId }` (no `input`). The clock replaces the click; the machinery is identical.

**The optional run `input`** (manual runs only). `input` is a per-run prompt typed into the composer. It is woven into the **first stage's** task — appended to that task's `description` under a `## Run input` heading and mirrored to `metadata.runInput`. The worker assembles its prompt from the task's `description`, so the input reaches the agent with no worker-side changes. It seeds the first stage only; downstream stages get the prior stage's deliverable via `prevOutput`, not the input. Omitting `input` (or sending blank/whitespace) runs the pipeline exactly as before — which is why the cron path, which never sends it, is unaffected. This is a lighter, intentionally-scoped feature than the run-wide `context` bag deferred in §8: a single first-stage prompt, no `${context.x}` interpolation.

(Note: the POST handler currently records the run's `trigger` as `{ type: 'manual', source: 'dashboard' }` for both paths, since cron pipelines reach it through the same HTTP endpoint. The `trigger.type` in the pipeline *definition* still documents intent and drives how it is installed.)

### 7. Validation

Nothing reaches the engine unvalidated. `scripts/validate-pipelines.sh` loads every `config/pipelines/*.json`, checks it against the canonical Zod schema in `pipelines.mjs`, confirms each file's `id` equals its filename, and **additionally verifies every `stage.command` (and every `gate.onFail.heal`) resolves to an existing `~/.claude/commands/<name>.md`**. Exit 0 means every pipeline is well-formed and every command it references exists. Run it in CI and before installing any cron.

```bash
#!/usr/bin/env bash
# scripts/validate-pipelines.sh — validate every config/pipelines/*.json
# against the canonical Zod schema, and verify every referenced worker command
# resolves to a slash-command file. Exit 0 iff everything passes.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PIPELINES_DIR="${PIPELINES_DIR:-config/pipelines}"
COMMANDS_DIR="${COMMANDS_DIR:-$HOME/.claude/commands}"

# 1. Schema check — load each file through the Zod schema in pipelines.mjs.
#    (No top-level zod install: pipelines.mjs resolves zod from dashboard/.)
node --input-type=module - "$PIPELINES_DIR" <<'NODE'
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolve(process.cwd(), process.argv[2]);
if (!existsSync(dir)) { console.log(`PASS: ${dir} missing (nothing to validate)`); process.exit(0); }

const { PipelineDefSchema } =
  await import(pathToFileURL(resolve('dashboard/lib/pipelines.mjs')).href);

const files = (await readdir(dir))
  .filter((f) => f.endsWith('.json') && f !== '.schema.json').sort();
if (files.length === 0) { console.log(`PASS: no pipeline files in ${dir}`); process.exit(0); }

let failed = 0;
for (const f of files) {
  let def;
  try { def = JSON.parse(await readFile(join(dir, f), 'utf8')); }
  catch (e) { console.error(`FAIL ${f}: invalid JSON — ${e.message}`); failed++; continue; }

  const result = PipelineDefSchema.safeParse(def);
  if (!result.success) {
    console.error(`FAIL ${f}:`);
    for (const i of result.error.issues)
      console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    failed++; continue;
  }
  if (def.id !== f.replace(/\.json$/, '')) {
    console.error(`FAIL ${f}: id "${def.id}" must equal filename`); failed++; continue;
  }
  console.log(`PASS ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
NODE

# 2. Command check — every stage.command and gate.onFail.heal must resolve to
#    a ~/.claude/commands/<name>.md file.
missing=0
for f in "$PIPELINES_DIR"/*.json; do
  [[ -e "$f" ]] || continue
  [[ "$(basename "$f")" == ".schema.json" ]] && continue
  while IFS= read -r cmd; do
    [[ -z "$cmd" || "$cmd" == "null" ]] && continue
    if [[ ! -f "$COMMANDS_DIR/${cmd}.md" ]]; then
      echo "FAIL $(basename "$f"): command '$cmd' -> $COMMANDS_DIR/${cmd}.md not found"
      missing=$((missing + 1))
    fi
  done < <(jq -r '
    [ .stages[].command,
      (.stages[].gate | select(.type=="test") | .onFail.heal) ] | .[]' "$f")
done

if (( missing > 0 )); then
  echo "FAIL: $missing missing command file(s)"; exit 1
fi
echo "PASS: all pipelines valid and all commands resolve"
```

The `/setup-pipeline` skill runs this same check when it authors a pipeline — a definition is never written without confirming every command it names exists.

### 8. Going further

The barebones engine is intentionally small: `cron`/`manual` triggers, three gates, single-`next` chains, per-stage `inputs` data flow (§2.2), `review` escalation. Add an advanced feature **only when a real workflow needs it** — never speculatively. When you do, extend the canonical schema in `pipelines.mjs` (and its `z.infer` types) — never a second copy. None of the following exist in the code today; they are deliberately deferred extension points:

- **`fanOut`** — one stage seeds N children, one per item in a list (process every file in a batch).
- **`parallel`** — run several sibling stages at once instead of a single `next`.
- **`next` as an array** — branch to multiple downstream stages from one stage.
- **`timeoutMin`** — per-stage wall-clock budget.
- **Run-wide `context`** — a shared key/value bag plus `${context.x}` interpolation in commands and gate scripts. (Distinct from `inputs`, which routes prior *deliverable files* by stage id; `context` would carry arbitrary scalar values. Reach for it only when file handoff via `inputs` genuinely cannot express the need.)
- **More triggers** — `task` (chain off another task) and `event` (external webhook).
- **`thenEscalate: "abort"`** — fail the run silently instead of escalating to the Captain.

One file, one schema, one engine — grow it on demand, never ahead of demand.
