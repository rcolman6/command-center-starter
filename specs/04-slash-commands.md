# Slash Commands — the reusable HOW

> A task says **what** to do. A slash command says **how** to do it. This spec is the playbook for writing one. Build your first `worker/*.md` here; that closes the loop (step 4 of the build order in `01-foundation.md`).

---

## What

A **slash command** is the reusable HOW for one *kind* of task: a frontmatter-gated markdown procedure. Write it once; every task of that kind follows it. The **task** carries the WHAT (the topic, the target, the request, the output id); the **slash command** carries the HOW (the ordered steps that turn that input into a deliverable).

A worker command is responsible for exactly this:

- **Read its inputs** — the task title/description (injected as the WHAT), task `metadata.*` fields, and any external path resolved through `config/paths.json`.
- **Do the work** — search, draft, analyze, transform, summarize.
- **Write a flat deliverable** — one or more top-level files in the run's output directory, in a named, predictable format.

A worker command is explicitly **NOT** responsible for:

- **Setting task status.** The worker owns the entire state machine (`pending → in_progress → needs_review → completed`). The command never sets, requests, or implies a status. (Invariant 2 in `00-system-map.md`: *the script owns state; Claude owns work.*)
- **Reporting back through an API.** The command makes **no `curl`/PATCH calls at all**. It does not write `claudeNotes` or `completionFile` — the worker *derives* both after the run (see **How**). The command's only output surface is the files it writes.
- **Selecting a model.** The task owns the model (`model` → `--model`); the command frontmatter only sets `disable-model-invocation`.

This is the leverage: author a procedure once, and the cron queue runs it for every future task of that kind.

The `worker/` namespace matters — these commands live under `commands/worker/`, separating headless automation procedures from interactive commands you run by hand in the CLI.

---

## Where

| Path | What it is |
|---|---|
| `commands/README.md` | The tracked-source + install model: these files are the source of truth; you install them into `~/.claude/commands/worker/`. |
| `commands/worker/research-topic.md` | Starter command — web research → sourced brief. |
| `commands/worker/draft-doc.md` | Starter command — first draft from a request + a source brief. |
| `commands/worker/review-doc.md` | Starter command — critique a draft against a rubric. |
| `commands/worker/summarize-transcript.md` | Starter command — condense a transcript to key points + actions. |
| `commands/worker/weekly-report.md` | Starter command — roll a week's items into a status report. |
| `config/paths.json` | The only place absolute external paths live (`outputs`, `knowledgeBase`, project paths). Commands resolve paths from here. |
| `workers/run-worker.sh` | The worker. Resolves a task's `slashCommand` to a command file and injects its body into the prompt (the injection point — see below). |

**Tracked source vs. installed copy.** `commands/worker/*.md` is the *tracked* source of truth (committed). The worker reads from `~/.claude/commands/`, **not** from this repo. So a command only resolves at runtime if it has been **installed** into your home command dir:

```bash
cp commands/worker/*.md ~/.claude/commands/worker/
```

Re-run that after editing any command here to keep the installed copies in sync with the tracked source. A task referencing a command that isn't installed will simply run without an injected HOW.

**The injection point (`workers/run-worker.sh`).** The worker defines the command root and resolves the task's `slashCommand` against it:

```bash
CMD_DIR="$HOME/.claude/commands"          # the worker reads installed commands, not the repo
...
SLASH="$(jq -r '.slashCommand // ""' <<<"$task")"   # e.g. "worker/research-topic"
...
if [ -n "$SLASH" ] && [ -f "$CMD_DIR/$SLASH.md" ]; then
  PROMPT+="
## How — slash command \`$SLASH\`
$(cat "$CMD_DIR/$SLASH.md")
"
fi
```

So `task.slashCommand = "worker/research-topic"` resolves to `~/.claude/commands/worker/research-topic.md`, and its **entire body (frontmatter included) is `cat`'d** into the prompt under a `## How — slash command` heading, beneath the task's WHAT (title, description, acceptance criteria, output dir). One file, many tasks: change the file and every future task of that kind picks up the change.

```
task.slashCommand = "worker/research-topic"
        │  worker resolves against CMD_DIR ($HOME/.claude/commands)
        ▼
~/.claude/commands/worker/research-topic.md  ──cat──►  injected under "## How" in the worker's prompt
```

If `slashCommand` is empty or the file isn't installed, the worker runs the task on its title/description alone — no HOW is injected.

---

## How — the command-authoring contract

### 1. Frontmatter

Every worker command starts with exactly this frontmatter — nothing more:

```markdown
---
disable-model-invocation: true
---
```

`disable-model-invocation: true` means the model can **not** call this command itself as a tool mid-conversation. It is worker-only: the worker harness injects the body, and the harness picks the model via `--model` from the task's `model` field (`sonnet` | `opus` | `haiku`, default `sonnet`). The command never selects its own model — the task does.

### 2. Read inputs (never hardcode paths)

- **The task description** — the specifics (topic, target, request). This is the WHAT, injected above the command body.
- **Task metadata** — `metadata.*` fields on the task (e.g. `metadata.depth`, `metadata.briefPath`, `metadata.previousCompletionFile`). Read them if the procedure needs them. In a pipeline, the engine hands the upstream stage's deliverable forward as `metadata.previousCompletionFile` (and on a `Previous stage output:` line) — downstream commands read it from there, never from any recollection of a prior run.
- **External paths** — resolve via `config/paths.json` (`outputs`, `knowledgeBase`, a project path). **NEVER hardcode an absolute path** (Invariant 4). Hardcoding `/home/you/...` is a defect.

### 3. Do the work and write a flat deliverable

Write deliverables to the run's output directory — `workers/workspace/outputs/{task-id}/` (the worker creates it and names it in the prompt; resolve the root from `outputs` in `config/paths.json`). Write **flat — top level, no nesting:**

- `outputs/{task-id}/brief.md` — yes.
- `outputs/{task-id}/sources/brief.md` — no.

The worker picks the primary file as `completionFile` by scanning the *top level* of that directory; nesting hides the deliverable. Name the exact format the command produces: a `.md` with known headings, or a JSON file with a fixed schema.

### 4. Do NOT report back — the worker derives completion

This is the contract that the worker actually enforces, and the most important rule. **The command makes no API call and writes no status, `claudeNotes`, or `completionFile`.** After the run, the worker derives everything deterministically from the filesystem — never from the agent:

- **`completionFile`** — the worker scans the top level of `outputs/{task-id}/`, preferring a recognizable primary file (names starting `readme`, `report`, `output`, `result`, `index`, `draft`, `review`), else the first file alphabetically. So naming your deliverable e.g. `draft.md` or `report.md` makes the worker pick it cleanly.
- **`claudeNotes`** — the worker uses `workers/workspace/notes/{task-id}.md` if the agent wrote brief working notes there, else the agent's final transcript message, else a generic line. (Optional: jot a one-line summary into the notes file to control the card text — but do **not** PATCH it.)
- **`status`** — the worker sets the spine default: `completed` if `metadata.autoMode === true` (auto/test stages), else `needs_review`. See §5.

**Signalling failure.** If the command cannot finish, it does **not** fake success. Write a file named `failure-<reason>.md`, or begin the notes with `Blocked:` (or `FAILED:`). The worker detects either signal and forces `needs_review` so a pipeline never auto-advances on a failed stage.

### 5. `auto` vs `needs_review` lives on the task, not the command

The default landing is `needs_review`: most tasks stop for the Captain. A task auto-completes only when it is safe to. The decision lives on the **task** via `metadata.autoMode`, and the **worker** applies it (full state machine in `02-worker-system.md`). The command's job is just to produce a clean, well-formed deliverable.

Rule of thumb when deciding whether a *kind* of task should set `autoMode: true`:

- **auto** — output is **non-destructive** and serves as **read-only context for a later step**: a research brief, a transcript summary, a critique. Auto-completing it just unblocks the next stage faster.
- **needs_review** — **anything the Captain will ship**: a draft, a report you send, anything published, sent externally, overwritten, or deleted. If a human's name goes on it or it leaves the building, it stops at the gate.

Maps to **Invariant 1** in `00-system-map.md`: *nothing ships without Captain approval; auto-completion is reserved for non-destructive intermediate steps.* When in doubt, leave it `needs_review`.

### 6. The canonical body template

Every worker command follows the same skeleton — four sections plus rules. **Note there is no `## Completion` section** (the worker derives completion):

```markdown
---
disable-model-invocation: true
---

# Worker: <Human Label>

<One sentence: what this command produces.>

## Inputs
- The **task description** — the specifics (the topic, the target, the request).
- **Task metadata** — `metadata.*` fields on the task (read them if the procedure needs them).
- **External paths** — resolve via `config/paths.json`. NEVER hardcode an absolute path.

## Steps
1. Read <X> (the description / a metadata field / a file resolved from paths.json).
2. Do <Y> (the actual work — search, draft, analyze, transform).
3. Produce <Z> (assemble the deliverable in the required format).

## Output
Write to `{paths.outputs}/{task-id}/<name>.md` — top level, no subfolders.
Name the exact format: a `.md` with known headings, OR a JSON file with a fixed schema.

## Rules
- No preamble, no cheerleading — state the artifact, not the process.
- Build only on the inputs; never fabricate. Flag gaps, don't fill them.
- (State the gate intent in prose if useful — but never set status yourself.)
```

Rules that make this skeleton work:

- **`# Worker: <Human Label>`** + one sentence. State the artifact, not a personality.
- **Inputs** names *where* things come from, never *what* the specific values are. The values live on the task.
- **`config/paths.json` is the only place absolute paths live.** A command reads it and resolves; hardcoding `/home/you/...` is a defect.
- **Output is flat**, so the worker can pick `completionFile` reliably.
- **No completion/PATCH section** — the worker derives `claudeNotes`, `completionFile`, and `status`. The command only writes files (and, optionally, a notes line).

### 7. A fully-worked example — `worker/research-topic`

This is the real installed file (`commands/worker/research-topic.md`). Hand it a topic in a task and it returns a sourced brief.

```markdown
---
disable-model-invocation: true
---

# Worker: Research Topic

Research a topic on the live web and produce a sourced, decision-ready brief.

## Inputs
- **The topic / question** — in the task description. This is the *what*. It may include
  a focus ("for a small business deciding whether to adopt X") and any must-cover angles.
- **`metadata.depth`** (optional) — `"quick"` (3-4 sources) or `"deep"` (8+ sources).
  Default to `"quick"` if absent.
- **Output root** — read `outputs` from `config/paths.json` (e.g. `workers/workspace/outputs`).
  Never hardcode a path.

## Steps
1. Read the task description. Restate the question in one line and decide the angles to cover
   (what it is, how it works, cost, alternatives, risks/gotchas, recommendation).
2. Search the live web with `WebSearch`. Open the strongest results with `WebFetch` and read
   them. Use real sources — not memory. Aim for the source count implied by `metadata.depth`.
3. Cross-check anything load-bearing (a price, a claim, a stat) against a second source.
   If sources disagree, present both and say which is more credible.
4. Write the brief using the exact headings in **Output**. Every factual claim cites a source.

## Output
Write to `{paths.outputs}/{task-id}/brief.md` — top level, no subfolders.

Required headings (in order):

# {Topic} — Research Brief
## Bottom Line   <2-3 sentences: the answer / recommendation up front.>
## What It Is    <1-2 paragraphs.>
## How It Works  <1-2 paragraphs — technical but accessible.>
## Key Details   <Bullets: cost, requirements, gotchas, alternatives.>
## Risks & Open Questions  <What could go wrong; what's still unresolved.>
## Sources       <Every URL used, one per line. No fabricated links.>

## Rules
- No preamble, no "Great question", no cheerleading. Brief, sourced, direct.
- Unsourced claims are defects. If you couldn't verify it, say so under Open Questions.
- This is read-only research — non-destructive. The Captain reads it as context for a later step.
```

Note what it does **not** do: it never sets a status, never calls an API, never hardcodes `/home/...`, never nests its output, and never assumes a previous stage's memory — it reads its inputs fresh from the task and resolves paths from `config/paths.json`.

### 8. The starter set

These five ship under `commands/worker/`. They are deliberately generic so you can see the shape; replace them with the procedures *your* business actually repeats. Build them one at a time.

| command | produces | inputs | gate default |
|---|---|---|---|
| `research-topic` | `brief.md` — sourced web-research brief | topic in description; `metadata.depth` | auto (read-only context) |
| `draft-doc` | `draft.md` — first draft from a request + brief | request in description; `metadata.briefPath` | needs_review (Captain ships it) |
| `review-doc` | `review.md` — critique of a draft against a rubric | rubric in description; `metadata.previousCompletionFile` | auto (advisory, non-destructive) |
| `summarize-transcript` | `summary.md` — key points + action items | `metadata.transcriptPath` (resolve via paths.json) | auto (intermediate artifact) |
| `weekly-report` | `report.md` — week rolled up into a status report | date range in description; `metadata.sourceDir` | needs_review (you send it out) |

The gate default is just a default — it's set per task via `metadata.autoMode`, and the worker (not the command) applies it. The same command can auto-complete in a trusted pipeline and land in `needs_review` standalone.

### 9. How completion data flows to the next stage

The next stage doesn't share memory with this one. It reads what *the worker* left on the task — `completionFile` (which the worker derived from this stage's flat output) and `metadata.*`. So the contract between stages is the file you write and where you write it:

- Write the deliverable **flat** with a recognizable name (`brief.md`, `draft.md`, `report.md`) so the worker picks it as `completionFile`. The pipeline engine then forwards that path to the next stage as `metadata.previousCompletionFile`.
- The downstream command's **Inputs** says *"read the draft at `metadata.previousCompletionFile`"* (or a named handoff key like `metadata.briefPath`) — it pulls the handoff off the task, not from any recollection of what ran before.

A `PATCH` to `metadata` **merges** (it does not replace — see `01-foundation.md` §4), so handoff keys accumulate across stages — but the command never issues that PATCH itself; the worker and the dashboard engine own all task writes.

### 10. Anti-patterns

Each of these breaks a canon invariant. Don't ship a command that does any of them.

| Anti-pattern | Why it's wrong | Do instead |
|---|---|---|
| Hardcoding an absolute path (`/home/you/notes/...`) | Breaks Invariant 4; the command stops working when a path moves or on another machine. | Read it from `config/paths.json`. |
| Setting task `status`, or PATCHing `claudeNotes`/`completionFile` | Breaks Invariant 2 — the worker owns state and derives completion from the filesystem. An agent that self-reports bypasses the contract. | Write files only; let the worker derive `completionFile`, `claudeNotes`, and `status`. |
| Nested output dirs (`outputs/{id}/sources/x.md`) | The worker scans the top level for `completionFile`; nested files are missed and the card can't find the deliverable. | Write flat: `outputs/{task-id}/x.md`. |
| Faking success when blocked | The Captain sees a card with no real output; a pipeline auto-advances on a failed stage. | Write `failure-<reason>.md` or begin notes with `Blocked:` / `FAILED:` — the worker forces `needs_review`. |
| Assuming prior-stage memory ("continue from the draft above") | There is no shared memory between stages — each runs fresh. The reference resolves to nothing. | Name the input explicitly: "read the draft at `metadata.previousCompletionFile`." |
| Baking the model into the command | The task owns the model (`--model`). | Leave model selection to the task; frontmatter just sets `disable-model-invocation`. |
| Personality/role-play padding instead of procedure | Burns tokens, hides the steps, drifts output. | State the artifact and the ordered steps. Concrete beats characterful. |

---

## In one line

A worker slash command is a frontmatter-gated markdown procedure that reads its inputs from the task and `config/paths.json` and writes a named, flat deliverable into `outputs/{task-id}/` — and it never calls an API, never sets status, and never writes `claudeNotes`/`completionFile`; the worker derives all of that from the filesystem. Write it once; install it into `~/.claude/commands/worker/`; the queue runs it forever.
