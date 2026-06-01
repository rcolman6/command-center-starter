---
disable-model-invocation: true
---

# Worker: Weekly Report

Roll up a week's worth of items from a source directory into a status report.

## Inputs
- **The date range and source** — in the task description: the week to cover (e.g.
  "2026-05-25 to 2026-05-31") and the source directory or feed to roll up.
- **`metadata.sourceDir`** (optional) — the directory of items to aggregate. If it is a
  bare name or sits under the knowledge base, resolve it against `knowledgeBase` from
  `config/paths.json`.
- **External paths** — read `knowledgeBase` and `outputs` from `config/paths.json`.
  Never hardcode a path.

## Steps
1. Read the task description for the date range and the source.
2. Resolve the source directory: use `metadata.sourceDir` if given, else the path in the
   description; if it is a bare name, join it to `knowledgeBase` from `config/paths.json`.
3. List the items in the source dated within the range. Read each one and pull what
   shipped, what progressed, what stalled, and what's next.
4. Aggregate into the headings in **Output**. Group related items; lead with outcomes, not
   activity. Cite the source item for each highlight so the Captain can drill in.

## Output
Write to `{paths.outputs}/{task-id}/report.md` — top level, no subfolders.

Required headings (in order):

```
# Weekly Report — {Date Range}

## Highlights
<2-4 bullets: the headline outcomes of the week.>

## Shipped
<Bullets: what was completed and delivered, with the source item.>

## In Progress
<Bullets: what advanced but isn't done, with current state.>

## Blocked / At Risk
<Bullets: what stalled and why. "None" if clear.>

## Next Week
<Bullets: the planned focus for the coming week.>

## Sources
<The items rolled up, one per line.>
```

## Rules
- No preamble, no cheerleading — state outcomes, not activity logs.
- Aggregate only what the source items actually contain; cite each highlight.
- This report goes out under the Captain's name — it defaults to `needs_review`. Leave
  status to the worker; just write a clean report.
