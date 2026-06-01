---
disable-model-invocation: true
---

# Worker: Review Doc

Critique a draft against a rubric and produce a list of issues with suggested edits.

## Inputs
- **The review focus** — in the task description: what the draft is for, the audience, and
  any rubric or criteria the Captain wants applied. If no rubric is given, use the default
  rubric in **Steps**.
- **The draft to review** — its path arrives as `metadata.previousCompletionFile` and on a
  `Previous stage output:` line in the description (the engine hands the upstream stage's
  deliverable forward automatically). If neither is present, the description names the path.
- **Output root** — read `outputs` from `config/paths.json` (e.g. `workers/workspace/outputs`).
  Never hardcode a path.

## Steps
1. Read the task description for the review focus and any supplied rubric.
2. Read the draft at `metadata.previousCompletionFile` (resolve it relative to the repo root).
3. Assess the draft against the rubric. If none was given, apply this default:
   accuracy (claims supported), clarity (plain, unambiguous), structure (point-first,
   logical order), completeness (covers the request), tone (matches the audience).
4. For each issue, record: the rubric dimension, where it occurs (heading or quoted
   snippet), why it's a problem, and a concrete suggested edit. This is advisory only —
   do NOT modify the draft.

## Output
Write to `{paths.outputs}/{task-id}/review.md` — top level, no subfolders.

Required headings (in order):

```
# Review — {Draft Title}

## Verdict
<2-3 sentences: ship as-is, ship with edits, or needs rework — and why.>

## Issues
<One entry per issue: dimension — location — problem — suggested edit.>

## Suggested Edits
<Concrete rewrites for the highest-impact issues, quoting the original then the proposed text.>

## Strengths
<What already works and should be preserved.>
```

## Rules
- No preamble, no cheerleading — state the verdict and the issues.
- Non-destructive: critique only, never edit the draft itself. The Captain applies fixes.
- Quote the draft when pointing at a problem so the edit is unambiguous.
