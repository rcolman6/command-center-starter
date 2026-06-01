---
disable-model-invocation: true
---

# Worker: Summarize Transcript

Condense a transcript into key points, decisions, and action items.

## Inputs
- **The transcript location** — `metadata.transcriptPath` names the file (often left by an
  upstream stage). If it is a bare name or lives under the knowledge base, resolve it
  against `knowledgeBase` from `config/paths.json`. The description may add focus
  ("pull only the action items", "summarize for the client").
- **External paths** — read `knowledgeBase` and `outputs` from `config/paths.json`.
  Never hardcode a path.

## Steps
1. Read the task description for any focus or audience.
2. Resolve the transcript path: use `metadata.transcriptPath` as given if absolute or
   repo-relative; otherwise join it to `knowledgeBase` from `config/paths.json`. Read the file.
3. Read the transcript end to end. Identify the throughline, the decisions made, the open
   questions, and every action item (who owns it, by when, if stated).
4. Condense to the headings in **Output**. Stay faithful to the transcript — do not add
   facts or opinions that were not said.

## Output
Write to `{paths.outputs}/{task-id}/summary.md` — top level, no subfolders.

Required headings (in order):

```
# Summary — {Transcript Label}

## TL;DR
<2-3 sentences: what this was and what came out of it.>

## Key Points
<Bullets: the substantive points, in the order they matter.>

## Decisions
<Bullets: what was decided. "None" if nothing was decided.>

## Action Items
<Bullets: owner — task — due (if stated). "None" if there are no actions.>

## Open Questions
<Bullets: what was raised but left unresolved.>
```

## Rules
- No preamble, no cheerleading — state the summary.
- Faithful to the transcript only: no invented facts, no added opinions.
- This is an intermediate artifact — non-destructive context for a later step.
