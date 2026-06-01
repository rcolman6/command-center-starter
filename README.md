# Command Center — Starter Pack

A complete, build-ready specification for a **barebones Command Center**: a personal AI operations system that runs on your own machine — a task queue, a cron worker, and a dashboard, with a human-in-the-loop review gate.

**This is not a repo to clone. It is a set of specs you feed to Claude Code.** You open Claude Code in an empty git repo, hand it these specs in order, and supervise the build. You end up with a system you understand natively — because you watched it get built, decision by decision. The build itself is the lesson in agentic coding.

By the end you have a working spine (a task through the full lifecycle) plus one real automation from your own business.

---

## Start here

- **If you're the operator** → read **[GUIDE.md](GUIDE.md)** first. Plain-English walkthrough: the loop, the two laws, how to build it, how to run your first automation, how to review.
- **If you're building** (you or Claude Code) → read **[specs/00-system-map.md](specs/00-system-map.md)**. It defines the vocabulary and the exact order to feed the specs.

---

## What's in the pack

```
starter-pack/
  README.md                          ← you are here
  GUIDE.md                           ← the operator's walkthrough (read first)
  specs/
    00-system-map.md                 ← entry point: the model, the loop, the two laws, the feed order
    01-foundation.md                 ← directory layout, the Task object, the lifecycle, build order
    02-worker-system.md              ← the cron worker loop (run-worker.sh) + system prompt
    03-dashboard.md                  ← the Next.js dashboard, /tasks, the needs-review bin
    04-slash-commands.md             ← how to write a worker/* command (the HOW)
    05-pipelines.md                  ← the pipeline engine + 4-tier model (ONE source of truth)
    06-observability.md              ← review the exact prompt + output of every agent (UI + CLI)
    07-config-and-cron.md            ← config/paths.json, the cron install, the Settings toggle
  skills/
    setup-pipeline/SKILL.md          ← /setup-pipeline — authors a whole pipeline in one conversation
```

## Build order (the short version)

Feed the specs in number order. Steps 1–4 are the spine and the goal of the first sitting; everything after is earned.

1. **01-foundation** → layout, config, the Task object.
2. **03-dashboard** → the UI + API on `localhost:18525`. Create and see tasks.
3. **02-worker-system** → the worker loop. Run it by hand once.
4. **04-slash-commands** → write one command, push a task through `pending → in_progress → needs_review → completed`. **The loop is closed.**
5. **07-config-and-cron** → the worker runs itself on a schedule.
6. **06-observability** → see exactly what each agent was told and produced.
7. **05-pipelines** → multi-stage pipelines. Then install **`/setup-pipeline`** and author your first real automation.

## The non-negotiables (true in every spec)

1. **Nothing ships without your approval.** Real output lands in `needs_review`. You approve or revise.
2. **The script owns state; Claude owns work.** The agent never sets its own status.
3. **One source of truth per concept.** A pipeline is one JSON file. A task is read/written through one path. Nothing is defined twice.
4. **Config over hardcoding.** External paths live in `config/paths.json`.
5. **Specs win.** If the code disagrees with a spec, fix one or the other — never let them drift.

---

## Installing the skill

Once your Command Center is built, install the pipeline author so `/setup-pipeline` works in Claude Code:

```bash
cp -r starter-pack/skills/setup-pipeline ~/.claude/skills/setup-pipeline
```

Then, in Claude Code from your Command Center repo: `/setup-pipeline build me a weekly report`.
