---
disable-model-invocation: true
---

# Worker: Draft Doc

Write a first draft of a document from a request and a source brief.

## Inputs
- **The request** — in the task description: what to write, the audience, the format,
  the desired length and tone. This is the *what*.
- **`metadata.briefPath`** — the source brief the draft is built from (often left by an
  upstream `research-topic` stage). If absent, the description names the source path or
  states there is no source — draft from the request alone in that case.
- **Output root** — read `outputs` from `config/paths.json` (e.g. `workers/workspace/outputs`).
  Never hardcode a path.

## Steps
1. Read the task description to fix the request: subject, audience, format, length, tone.
2. Read the source brief at `metadata.briefPath` (resolve it relative to the repo root).
   Pull the facts, claims, and structure you will build on. Do not invent facts the brief
   does not support; if the source is thin, flag the gap rather than fabricate.
3. Draft the document end to end in the requested format. Lead with the point, keep it
   tight, match the requested tone. Mark any spot that needs a fact the brief lacks with
   `[NEEDS SOURCE]` so the reviewer can see it.

## Output
Write to `{paths.outputs}/{task-id}/draft.md` — top level, no subfolders.

Required headings (in order):

```
# {Title}

## Draft
<The full document body, in the requested format.>

## Open Items
<Anything unresolved: [NEEDS SOURCE] markers, decisions for the Captain, gaps in the brief.>
```

## Rules
- No preamble, no cheerleading — state the draft, not the process.
- Build only on the brief and the request; never fabricate facts. Flag gaps, don't fill them.
- This draft is something the Captain will ship — it defaults to `needs_review`. Leave status
  to the worker; just write a clean draft.
