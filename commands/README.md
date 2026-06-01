# Worker Slash Commands — tracked source

The files under `commands/worker/` are the **tracked source of truth** for the
Command Center's worker slash commands. Each one is the reusable HOW for a kind
of task: a frontmatter-gated markdown procedure that reads its inputs from the
task + `config/paths.json`, writes a flat deliverable to
`workers/workspace/outputs/{task-id}/`, and PATCHes `claudeNotes` +
`completionFile` (never status). See `specs/04-slash-commands.md` for the contract.

## Install

The worker resolves a task's `slashCommand` field — e.g. `worker/research-topic`
— to `~/.claude/commands/worker/research-topic.md` and injects that file's body
into the prompt. So the commands must be installed into your home command dir:

```bash
cp commands/worker/*.md ~/.claude/commands/worker/
```

Re-run that after editing any command here to keep the installed copies in sync
with this tracked source.

## The starter set

| command | produces | gate default |
|---|---|---|
| `research-topic` | `brief.md` — sourced web-research brief | auto |
| `draft-doc` | `draft.md` — first draft from a request + brief | needs_review |
| `review-doc` | `review.md` — critique of a draft against a rubric | auto |
| `summarize-transcript` | `summary.md` — key points + action items | auto |
| `weekly-report` | `report.md` — week rolled up into a status report | needs_review |

The gate default is just a default — it's set per task via `metadata.autoMode`,
and the worker (not the command) applies it.
