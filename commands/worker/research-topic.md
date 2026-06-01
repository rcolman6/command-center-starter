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

```
# {Topic} — Research Brief

## Bottom Line
<2-3 sentences: the answer / recommendation up front.>

## What It Is
<1-2 paragraphs.>

## How It Works
<1-2 paragraphs — technical but accessible.>

## Key Details
<Bullets: cost, requirements, gotchas, alternatives — whatever is load-bearing.>

## Risks & Open Questions
<What could go wrong; what's still unresolved.>

## Sources
<Every URL used, one per line. No fabricated links.>
```

## Rules
- No preamble, no "Great question", no cheerleading. Brief, sourced, direct.
- Unsourced claims are defects. If you couldn't verify it, say so under Open Questions.
- This is read-only research — non-destructive. The Captain reads it as context for a later step.
