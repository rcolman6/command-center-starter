---
name: setup-pipeline
description: Interactively design and wire a multi-stage Command Center pipeline. Writes ONE canonical definition (config/pipelines/<id>.json), one worker slash-command stub per stage, and (optionally) the cron entry — then validates. One source of truth: the JSON file. Manual invocation via /setup-pipeline.
disable-model-invocation: true
argument-hint: [one-line goal]
---

# setup-pipeline

You are walking the Captain through designing a multi-stage pipeline and then
**writing the files that register it**. Canon: `specs/00-system-map.md`,
`specs/01-foundation.md`, and `specs/05-pipelines.md`. If a spec disagrees with
this body, the spec wins.

Goal: $ARGUMENTS

If `$ARGUMENTS` is empty, ask: "What should this pipeline do, in one sentence?"

**The one law of this skill: the JSON file is the only source of truth.** A
pipeline is registered by the existence of `config/pipelines/<id>.json` and
nothing else. The dashboard derives `/pipelines` at runtime by reading that
directory. You never edit a registry, never seed a task, never duplicate the
definition. Author the JSON, author the stubs the JSON points at, validate, done.

---

## The six questions

Ask these in order. Propose; let the Captain dispose. Surface assumptions — do
not invent details.

1. **What does it do?** One sentence. Use `$ARGUMENTS` as the starting goal if
   given. This becomes `description`.
2. **What are the stages?** Propose a breakdown from the goal — each stage is one
   worker slash command doing one job, output feeding the next. The Captain
   adjusts. Fewer is better; a stage exists only if it has a distinct deliverable.
3. **How does data flow between the stages?** This is `inputs`, and it is
   separate from the stage *order*. By default each stage receives **only the
   immediately-preceding stage's** deliverable (as `metadata.previousCompletionFile`)
   — that is all a straight chain needs, so you write nothing. But when a stage
   needs an **earlier** stage's output — e.g. a final "assemble" stage that needs
   both the research from stage 1 and the draft from stage 3 — give that stage an
   `inputs` array naming those upstream stage ids. The engine resolves each id to
   that stage's deliverable and hands them forward **by name** (in the task
   description and as `metadata.inputs`). Walk the stages and ask, per stage:
   *"does this one need anything other than the stage right before it?"* If yes,
   that's its `inputs`. Rule: `inputs` may only name stages that run **earlier**
   in the chain (the validator enforces this).
4. **What gate after each stage?** Explain the three and pick one per stage:
   - `auto` — progress immediately. **Default.** Use for non-destructive
     intermediate steps (research, aggregation, a draft handed to the next stage).
   - `review` — the Captain approves before the run advances. Use only at
     meaningful inflection points (the thing that ships, a costly fork). Two or
     more review gates needs a reason.
   - `test` — a deterministic command verifies the deliverable; on non-zero exit
     the engine runs a **heal** stub up to `maxRetries`, then escalates to
     `review`. Use only where a real verifiable check exists (a build, a schema
     check, a file-exists assertion). A vague test command is an anti-pattern.
5. **Cron or manual?** If cron, get the schedule in words and build the 5-field
   cron expression (e.g. "every morning at 3am" → `0 3 * * *`). If manual, the
   run starts only when the Captain triggers it.
6. **Name, id, description.** `id` is kebab-case and **equals the JSON filename**
   (`config/pipelines/<id>.json`). `name` is the human label. Confirm all three.

Then render a short plan — id, name, trigger, the stage→gate→next chain (control
flow), the data-flow edges (which stage reads which, calling out any non-default
`inputs`), and the stubs to create — and ask: **"Go or no-go?"** Only on **go**
do you write anything.

---

## Procedure

1. Ask the six questions; render the plan; get an explicit **go**.
2. Write `config/pipelines/<id>.json` — the canonical definition (schema below).
   This single file is the registration.
3. For each stage, write `~/.claude/commands/worker/<name>.md` from the worker
   stub template below. The stage's `command` is `worker/<name>`; the stub at
   that path IS the stage's instructions.
4. For each `test` gate, also write the heal stub the gate's `onFail.heal` names
   (`worker/<heal-name>.md`): it reads the failed test output and fixes the
   deliverable so the re-run passes.
5. If cron: **offer** to install the crontab entry (below). Don't force it.
6. **Validate** (see Validation). Write everything first, then validate, then fix
   and re-validate until clean.
7. Report (see After).

---

## What gets written

| Path | What | How many |
|---|---|---|
| `config/pipelines/<id>.json` | The canonical definition. The only registration. | exactly 1 |
| `~/.claude/commands/worker/<name>.md` | One stub per stage — the stage's instructions. | 1 per stage |
| `~/.claude/commands/worker/<heal-name>.md` | Heal stub for each `test` gate. | 1 per test gate |
| crontab line (offered) | Only if `trigger.type === "cron"`. | 0 or 1 |

Nothing else. No registry edit, no seeded task, no plan file, no duplicate def.

### A. The canonical definition — `config/pipelines/<id>.json`

Match this schema EXACTLY (validated by `dashboard/lib/pipelines.mjs`):

```jsonc
// PipelineDef
{
  "$schema": "./.schema.json",            // optional, ignored at runtime
  "id": "<id>",                           // kebab-case, == filename
  "name": "<Human Name>",
  "description": "<one sentence>",        // optional but write it
  "trigger": { "type": "cron", "cron": "0 3 * * *" },  // or { "type": "manual" }
  "stages": [ /* Stage[] — at least one */ ]
}
```

```jsonc
// Stage
{
  "id": "<stage-id>",                     // unique within the pipeline
  "label": "<short label>",               // optional
  "command": "worker/<name>",             // resolves to a stub you write
  "gate": { /* one of the three below */ },
  "inputs": ["<earlier-stage-id>", ...],  // OPTIONAL data flow. Omit for the default
                                          // (the immediately-preceding stage). Declare
                                          // to read ANY earlier stage(s) by id. Each id
                                          // MUST run earlier in the chain.
  "next": "<next-stage-id>"               // OMIT on the terminal stage
}
```

`inputs` is **data flow**; `next` is **control flow**. They are independent: a
stage can run after stage 3 (`next`) yet read stage 1's deliverable (`inputs:
["stage1"]`). Only emit `inputs` when a stage genuinely needs an output other
than the one right before it — a clean linear chain needs no `inputs` at all.

```jsonc
// Gate — exactly one of:
{ "type": "auto" }
{ "type": "review", "instructions": "<what the Captain checks; optional>" }
{ "type": "test",
  "command": "<deterministic shell check; non-zero = fail>",
  "onFail": { "heal": "worker/<heal-name>", "maxRetries": 2, "thenEscalate": "review" }
}
```

**Stay in the barebones scope. Do NOT emit:** `fanOut`, `parallel`, `next` as an
array, `context`, `timeoutMin`, `trigger.type` `task`/`event`, or
`onFail.thenEscalate: "abort"`. The validator accepts some of these for the full
engine, but this skill authors the barebones model only.

### B. The worker stub — `~/.claude/commands/worker/<name>.md`

One per stage. The body is the entire instruction set for that stage — there is
no shared memory and no plan file. Each stage reads its inputs fresh off the task
(the prior stage's deliverable arrives as `metadata.previousCompletionFile`, plus
the task description and any other `metadata.*`) and from `config/paths.json`.
Never hardcode an absolute path.

```markdown
---
disable-model-invocation: true
---

# Worker: <Label>

<One sentence: what this stage produces.>

## Inputs
- The **task description** — the specifics for this run.
- **Task metadata** — `metadata.*` fields. The engine's handoffs live here:
  `metadata.previousCompletionFile` (the immediately-preceding stage's deliverable)
  and, when this stage declares `inputs`, `metadata.inputs` — a
  `{ stageId: path }` map of the earlier deliverables it reads by name. Each path
  is repo-relative; `dirname` it to read sibling files the upstream stage wrote.
  Read what you need.
- **External paths** — resolve via `config/paths.json`. NEVER hardcode a path.

## Steps
1. <read the input>
2. <do the work>
3. <assemble the deliverable in a named format>

## Output
- Write deliverables to `workers/workspace/outputs/{task-id}/` — top level, flat,
  no nested dirs. Name the exact format (`<file>.md` with known headings, or JSON
  with a fixed schema).

## Completion
- Do NOT call any API or set status — the worker owns all of it. After you exit, it
  derives `completionFile` (scanning `workers/workspace/outputs/{task-id}/`) and
  `claudeNotes` (from your notes file / final message), then sets the task status.
  Just write the deliverable as a flat file; the engine hands it to the next stage
  as `metadata.previousCompletionFile`, and to any later stage that declares this
  one in its `inputs` as an entry in that stage's `metadata.inputs`.
```

For a **test gate's heal stub** (`worker/<heal-name>.md`): same frontmatter; the
body reads the failed test command's output, diagnoses the failure, edits the
deliverable in `outputs/{task-id}/` so the same test passes on re-run, and writes a
short notes file describing the fix (the worker captures it — no API call).

### C. The cron entry (offered, only if `trigger.type === "cron"`)

`dashboard/lib/cron.ts`'s `installCron` is interval-based and is for the worker
loop, not a per-pipeline schedule. For this pipeline's own `trigger.cron`, append
a marked line via `crontab -`, preserving existing lines:

```bash
( crontab -l 2>/dev/null | grep -v '# CC-PIPELINE <id>'; \
  echo '<cron> cd /home/romij/claude_accessible/command-center && <trigger command for this pipeline> # CC-PIPELINE <id>' ) \
  | crontab -
```

Confirm the schedule with the Captain before installing. If they decline, leave
the crontab untouched — the definition is still registered; it just runs manually.

---

## Validation (do this before declaring done)

1. Run `bash scripts/validate-pipelines.sh`. The new JSON must PASS the Zod
   schema. If it fails, fix the JSON and re-run until clean.
2. Confirm every `stages[].command` and every `gate.onFail.heal` resolves to a
   stub file that now exists under `~/.claude/commands/worker/`. A `command`
   pointing at a missing stub is a broken pipeline.
3. Confirm the terminal stage omits `next`, every `next` points at a real stage
   id, every `inputs` entry names a stage that runs **earlier** in the chain, and
   `id` matches the filename.

Only after all three pass do you report success.

---

## After creating

Tell the Captain:
- **(a)** The exact paths written — the JSON and each stub (and the crontab line
  if installed).
- **(b)** It already appears on `/pipelines` — the dashboard reads
  `config/pipelines/*.json` at runtime; no registration step was needed.
- **(c)** How a run starts: cron fires on schedule (if `trigger.type === "cron"`),
  or the Captain triggers it manually (if `manual`).
- **(d)** How to review each stage's prompt + output: see `06-observability.md`
  (per-agent prompt snapshot + session capture in the dashboard / CLI).

---

## Anti-patterns

- **More than one source of truth.** The JSON file is it. Do not also write a
  plan file, a second definition, or anything that has to be kept in sync.
- **Editing a registry constant.** There is no registry. The dashboard derives
  the list from the directory. Touching a constant means the JSON and the list
  can disagree — exactly the bug this skill replaces.
- **Seeding a task or pre-seeding a run.** The pipeline runs when its cron fires
  or it's triggered. Never POST to a task queue or a bub queue here.
- **Vague test commands.** `test: "looks good"` is not a gate. A test command is
  a deterministic shell check that exits non-zero on failure. If there's no real
  check, use `auto` or `review`, not `test`.
- **Two or more review gates without a reason.** Default `auto`; reserve `review`
  for the genuine ship/fork points. Human-out-of-the-loop is the goal.
- **Hand-editing `tasks.json`** (or any data file). Tasks flow through the
  dashboard API; this skill never writes one.
- **Hardcoding a path or assuming prior-stage memory in a stub.** Read inputs
  fresh from the task + `config/paths.json`; the prior stage's handoff is on the
  task (`completionFile` / `metadata.*`), not in any recollection.
- **Silently relying on a non-adjacent stage's output.** A stage receives only
  the *previous* stage's deliverable unless you declare `inputs`. If a stub's
  Steps read "stage 1's research" but the stage doesn't list `inputs: ["stage1"]`,
  that path is never handed to it — the agent will fabricate or fail. Declare the
  dependency; never assume the engine reaches back on its own.
