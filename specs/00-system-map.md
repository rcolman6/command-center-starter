# Command Center — System Map

> **Read this first.** This is the entry point for the entire Starter Pack. It tells you what you are building, the vocabulary every other spec uses, where each domain is documented, and the exact order to feed these specs to Claude Code.

## What

You are building a **Command Center**: a personal AI operations system that runs on your own machine. You create tasks. A cron job feeds them to Claude. Claude does the work. The output lands in a review bin for you to approve. Nothing goes live without your say-so.

This pack is a set of **specs**, not a repo to clone. You feed them to Claude Code, supervise the build, and end up with a system you understand natively because you watched it get built — line by line, decision by decision.

### The whole system in one diagram

```
You (the Captain)            Dashboard (See)              Worker (Do)
    |                            |                            |
    +-- Create tasks             +-- Task list + statuses     +-- Cron fires every N minutes
    +-- Review needs_review      +-- Create-task form         +-- Claims highest-priority pending task
    +-- Approve / revise         +-- Needs-review bin         +-- Runs Claude with a slash command
    +-- Set priorities           +-- Pipeline view            +-- Writes deliverables to workspace/
    +-- Add taste                +-- Settings (worker on/off) +-- Sets task to needs_review
    |                            +-- http://localhost:18424   +-- Reverts to pending on failure
```

Three moving parts: a **task queue** (a JSON file), a **worker** (a bash script on cron), and a **dashboard** (a Next.js app). That is the entire infrastructure. No Docker, no database server, no Redis, no queue service.

### The loop

Every Command Center runs the same loop. Understand the loop and you understand the system.

1. **You create a task** — a title, a slash command (the instructions), a priority.
2. **It sits in the queue** — status `pending`. Waiting for the worker.
3. **Cron fires** — every N minutes a bash script wakes up and checks the queue.
4. **The worker grabs the top task** — highest priority first. Sets it to `in_progress`.
5. **Claude does the work** — reads the slash command, executes the steps, writes deliverables.
6. **Output lands in `needs_review`** — you open the dashboard and read what Claude produced.
7. **You approve or revise** — approve and it's `completed`; add notes and send it back to `pending` for another pass.

The review step is a **gate**. Some gates need your eye (`review`). Some auto-complete (`auto`). Some are verified by a script (`test`). You decide the trust level per task type.

### The two laws of automation

These are the philosophy the whole system encodes. Teach yourself these before you build.

**Law 1 — Anything that can reasonably be automated should be automated, and you put the human at the review gate.** Reviewing the work is higher-leverage than doing it. The human-in-the-loop is not a fallback for when automation fails — it is the design. You are not removing yourself; you are relocating yourself to the highest-leverage point: the `needs_review` bin.

**Law 2 — Anything you can do in Claude Code, you can do in the Command Center.** The Command Center is just Claude Code on a cron with a queue and a review gate. That sentence sets the scope: everything you already do in the terminal, minus you having to sit there.

The goal is that there are only **two places you ever visit**: your **needs-review bin** (where you approve work) and your **CLI** (where you build new automations and do hands-on coding). Everything else runs in the background.

### The three layers you are building

| Layer | What it is | Built how |
|-------|------------|-----------|
| **1. The Spine** | Task queue + worker + cron + the needs-review bin. The loop. | Identical for everyone. Generate it from these specs. |
| **2. The Pipeline Engine** | The machinery that chains tasks into multi-stage pipelines, plus `/setup-pipeline` to author new ones. | Generate from spec; then author your own pipelines. |
| **3. Your automations** | The slash commands and pipelines specific to *your* business. | Build these by hand (or with `/setup-pipeline`). This is where the value lives. |

Layers 1 and 2 are convergent — every Command Center has the same spine and engine. Layer 3 is divergent — it is yours, and it is what "fits you."

**The build target:** an empty git repo. By the end you have a working barebones Command Center plus one real automation from your own business.

## Where

This file is the **map of the map**. Each domain has exactly one spec that owns it. When in doubt about a concept, this table tells you which spec to open.

| # | Spec | Owns | Layer |
|---|------|------|-------|
| 00 | `00-system-map.md` | *(this file — the entry point, vocabulary, feed order)* | — |
| 01 | `01-foundation.md` | Directory layout, the Task object, config, build order | Spine |
| 02 | `02-worker-system.md` | `workers/run-worker.sh` — the cron worker loop | Spine |
| 03 | `03-dashboard.md` | The Next.js dashboard: `/tasks`, `/settings`, `/pipelines`, the needs-review bin | Spine |
| 04 | `04-slash-commands.md` | How to write a `worker/*` command (your first one, end to end) | Spine |
| 05 | `05-pipelines.md` | The pipeline engine + the 4-tier pipeline model | Engine |
| 06 | `06-observability.md` | Per-agent prompt + output review (UI and CLI) | Engine |
| 07 | `07-config-and-cron.md` | `config/paths.json`, cron install, the Settings toggle | Spine |

Then install the **`/setup-pipeline`** skill (`skills/setup-pipeline/`) and author your first real pipeline.

The companion **`GUIDE.md`** is the human walkthrough — read it alongside this pack. It is the "what do I actually do" narrative; the specs are the "what Claude builds."

### Top-level directory map

```
command-center/
├── specs/           00–07 — the source of truth (this pack)
├── dashboard/       Next.js app (See). app/ pages, app/api routes, lib/, components/
│   └── data/        the database: tasks.json, pipeline-runs.json, cron-config.json
├── workers/         the worker (Do)
│   ├── run-worker.sh    cron-fired claim-run-record loop
│   ├── lib/             worker helpers
│   ├── logs/            run logs
│   └── workspace/       deliverables: outputs/, notes/, sessions/ (disposable)
├── config/          paths.json + pipelines/<id>.json definitions
├── commands/        worker/*.md slash commands (the HOW for tasks)
├── scripts/         install-cron.sh, trigger-pipeline.sh, validate-pipelines.sh, lib/
└── skills/          setup-pipeline/ — the pipeline-authoring skill
```

## How

### Feed order

Feed these specs to Claude Code **in the 00→07 order shown in the table above**. Each builds on the last. Do not skip ahead — get each layer working before adding the next. The order is: read the map (00), build the foundation (01), the worker (02), the dashboard (03), your first slash command (04), then the pipeline engine (05) and observability (06), then wire config and cron (07).

### Invariants (true everywhere, never violated)

1. **Nothing ships without Captain approval.** All real output lands in `needs_review`. Auto-completion is reserved for non-destructive intermediate steps.
2. **The script owns state. Claude owns work.** Status transitions, claims, retries, and pipeline progression all happen in code — never set by the agent. Claude produces deliverables; the worker decides status.
3. **One source of truth per concept.** A pipeline is defined in exactly one place (`config/pipelines/<id>.json`). A task is read/written through exactly one path (the dashboard API). Never duplicate a definition.
4. **Config over hardcoding.** External paths live in `config/paths.json`. Never hardcode an absolute path.
5. **Specs are source of truth.** If a spec disagrees with the code, the spec wins — update one or the other, never let them drift.

### Glossary (the only vocabulary that exists)

- **Captain** — you, the human. The only quality gate. Claude proposes, the Captain disposes.
- **Task** — one unit of work. A JSON object in `dashboard/data/tasks.json`. Has a status, a priority, and (usually) a slash command. Full schema in `01-foundation.md`.
- **Slash command** — a markdown file in `~/.claude/commands/worker/*.md` that tells Claude *how* to do a task. The task says *what*; the slash command says *how*. The worker reads it from `$HOME/.claude/commands/$SLASH.md`. Schema in `04-slash-commands.md`.
- **Worker** — `workers/run-worker.sh`. The cron-triggered script that claims a task, runs Claude on it, and records the result. It owns the state machine; Claude owns the work.
- **Status** — one of exactly four: `pending` → `in_progress` → `needs_review` → `completed`. No others.
- **Gate** — what happens when a stage finishes: `auto` (progress now), `review` (Captain approves first), `test` (a script verifies). Exactly three.
- **Pipeline** — a chain of stages defined in one JSON file under `config/pipelines/`. Each stage = one slash command + one gate. Schema in `05-pipelines.md`.
- **Pipeline run** — one execution of a pipeline definition. Tracked in `dashboard/data/pipeline-runs.json`.
- **Workspace** — `workers/workspace/`. Where Claude writes deliverables (`outputs/{task-id}/`), notes (`notes/{task-id}.md`), and session captures (`sessions/{task-id}.json`). Disposable; not committed.

## Cross-references

- `GUIDE.md` — the human walkthrough that runs alongside this pack.
- `01-foundation.md` — the Task object schema and directory layout in full.
- `05-pipelines.md` — pipeline definition shape and the engine that runs it.
