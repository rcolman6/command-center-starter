# The Command Center — User Guide

*For the Captain. The human walkthrough that sits next to the specs.*

Welcome aboard. This guide is the plain-English story of what you're building and, more importantly, **what you actually do** once it's running. The specs (in `specs/`) tell Claude how to build the machine. This tells you how to be the Captain of it.

Read it start to finish once. It's short on purpose.

---

## What the Command Center is

It's your personal AI operations system. It runs on your own machine and has exactly three moving parts:

- A **task queue** — a list of work you want done.
- A **worker** — Claude, waking up on a timer to do that work.
- A **dashboard** — a simple web page where you see and review everything.

The rhythm is always the same: **you create a task, Claude does the work, you approve the output.** Nothing goes live without your say-so.

Here's the promise that makes this worth building. Once it's running, there are only **two places you ever need to visit**:

1. Your **needs-review bin** — where you read what Claude produced and click Approve.
2. Your **terminal (the CLI)** — where you build new automations and do hands-on coding.

Everything else — the timing, the claiming, the running, the file-writing — happens in the background while you're doing something else. You stop being the person *doing* the work and become the person *approving* it.

---

## The loop

Every Command Center runs one loop. Learn it and you understand the whole system.

1. **You create a task** — a title, a slash command (the instructions), a priority.
2. **It waits in the queue** — status `pending`.
3. **The timer fires** — every few minutes a small script wakes up and checks the queue.
4. **The worker grabs the top task** — highest priority first, and marks it `in_progress`.
5. **Claude does the work** — follows the instructions, writes the result.
6. **It lands in your review bin** — status `needs_review`.
7. **You approve or revise** — approve and it's `completed`; or send it back with notes for another pass.

That's it. Four statuses, one loop: `pending` → `in_progress` → `needs_review` → `completed`.

---

## The two laws

These are the mindset shift. Sit with them before you build.

**Law 1 — Automate what can reasonably be automated, and stand at the review gate.** Reviewing work is higher-leverage than doing it. The human-in-the-loop isn't a safety net for when the robot fails — it *is* the design. You're not removing yourself; you're moving yourself to the single most valuable spot: the needs-review bin.

**Law 2 — Anything you can do in Claude Code, you can do in the Command Center.** The Command Center is just Claude Code on a timer, with a queue and a review gate. So the scope is simple: everything you already do in the terminal, minus you having to sit there while it happens.

---

## The three layers

You build the system in three layers, in this order:

1. **The Spine** — the task queue, the worker, the timer, and the review bin. The loop itself. This is identical for everyone.
2. **The Pipeline Engine** — the machinery that chains tasks into multi-step pipelines, plus a tool to author new ones.
3. **Your own automations** — the slash commands and pipelines specific to *your* business. This is where the value lives, and it's the part only you can build.

Layers 1 and 2 are the same for everybody. Layer 3 is yours. Build them in order — don't reach for layer 2 until the spine closes the loop.

---

## How you actually build it

Here's the part that surprises people: **you are not cloning a repo.**

You open Claude Code in an empty git repo and feed it the specs **in order**, from `00` to `07`. Claude writes the code. You watch, you supervise, you approve. You are directing and approving — not typing the code yourself.

That's deliberate. The build *is* the lesson in agentic coding. By the time the machine works, you'll understand it natively, because you watched every decision get made.

The order is laid out in the **feed-order table** in `specs/00-system-map.md`. Each spec has a role — read that table so you know what each one builds before you hand it over. Roughly:

- `01-foundation` — the layout, the Task object, the build order.
- `02-worker-system` — the worker loop.
- `03-dashboard` — the web page where you see and review tasks.
- `04-slash-commands` — how to write your first instruction file, end to end.
- `05-pipelines` — chaining tasks into pipelines.
- `06-observability` — seeing exactly what each agent was told and produced.
- `07-config-and-cron` — the timer and the on/off switch.

Feed them one at a time. Get each working before the next. You're never more than one spec ahead of yourself.

---

## Your first milestone: one task, all the way through

Don't try to build everything before you test anything. The goal of your first sitting is one thing:

**Get a single task through the full lifecycle:** `pending` → `in_progress` → `needs_review` → `completed`.

You'll:

1. Create a task in the dashboard.
2. Run the worker (by hand the first time).
3. Watch it pick up your task and do the work.
4. See it land in your needs-review bin.
5. Read it. Click **Approve**.

When that loop closes — when one real task goes all the way from idea to approved — you have a real Command Center. Everything after is just adding more of what you've already proven works.

---

## Your first automation

Now the fun part. Pick **one thing you do manually every week.** A status report. A draft. A summary. Anything repetitive.

In Claude Code, type:

```
/setup-pipeline
```

It asks you five questions:

1. What does this pipeline do?
2. What are the stages (the steps)?
3. What's the gate for each stage — do you review it, does a script check it, or does it just proceed?
4. Should it run on a timer (cron) or only when you start it?
5. What's it called?

Answer those, and it writes the whole thing for you: the pipeline definition, the slash commands behind each stage, and the timer entry if you asked for one. You go from "I have an idea" to "it's running" in a single conversation.

---

## How to review (the part you'll do every day)

This is your daily job, and it takes minutes.

1. Open the dashboard at **`localhost:18525/tasks`**.
2. Click the **Needs Review** filter.
3. Read the card. The card can show the deliverable **right there** — a document, a draft, a code diff — so you don't have to go digging.
4. Click **Approve** or **Revise**.

You're never approving blind. The card can show you exactly what the agent was told and exactly what it produced — the prompt and the output are both reviewable (see `06-observability.md` for how this works). So when you click Approve, you know precisely what you're approving.

That's the whole loop from your side. Read, judge, click.

---

## The revision loop

Here's what makes this calm instead of frustrating: when the output isn't right, **you don't start over, and you don't chat back and forth.**

You click **Revise**, type what to change, and the task goes back to `pending`. The worker picks it up again, reads your notes, and **refines the existing output** — it resumes the previous session rather than starting from scratch. Each pass gets closer. You keep clicking Revise with sharper notes until it's right, then you Approve.

No long conversations. No re-explaining. Just structured feedback that feeds the next pass.

---

## The ramp — your first few weeks

Don't rush. The system rewards going slow at the start.

**Week 1 — Build the spine.** Feed the specs in order, stand up the dashboard and worker, and get one task through the full loop. That's the win for week one. Stop there and let it sink in.

**Week 2 — Your first automation.** One slash command. One single-stage pipeline with a review gate. Put it on a timer. Pick something small and real — something you'd otherwise do by hand this week.

**Week 3 and beyond — Expand.** Add a second stage to a pipeline. Try an `auto` gate between stages, so one step flows into the next without you. Build a second pipeline. When you have a real script that can verify an output, add a `test` gate so a machine checks the work before it reaches you.

Each week you do a little more, and each thing you add is permanent.

---

## The ethos

Start small. One task. One pipeline. One gate. Get that working, then expand.

The Command Center is not a product you install — it's a system you build, piece by piece, for your business. Every pipeline you add is one more thing you never do manually again.

Welcome to the bridge, Captain.
