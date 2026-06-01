#!/usr/bin/env bash
# scripts/validate-pipelines.sh — validate every config/pipelines/*.json
# against the canonical Zod schema, and verify every referenced worker command
# resolves to a slash-command file. Exit 0 iff everything passes.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PIPELINES_DIR="${PIPELINES_DIR:-config/pipelines}"
COMMANDS_DIR="${COMMANDS_DIR:-$HOME/.claude/commands}"

# 1. Schema check — load each file through the Zod schema in pipelines.mjs.
#    (No top-level zod install: pipelines.mjs resolves zod from dashboard/.)
node --input-type=module - "$PIPELINES_DIR" <<'NODE'
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = resolve(process.cwd(), process.argv[2]);
if (!existsSync(dir)) { console.log(`PASS: ${dir} missing (nothing to validate)`); process.exit(0); }

const { PipelineDefSchema } =
  await import(pathToFileURL(resolve('dashboard/lib/pipelines.mjs')).href);

const files = (await readdir(dir))
  .filter((f) => f.endsWith('.json') && f !== '.schema.json').sort();
if (files.length === 0) { console.log(`PASS: no pipeline files in ${dir}`); process.exit(0); }

let failed = 0;
for (const f of files) {
  let def;
  try { def = JSON.parse(await readFile(join(dir, f), 'utf8')); }
  catch (e) { console.error(`FAIL ${f}: invalid JSON — ${e.message}`); failed++; continue; }

  const result = PipelineDefSchema.safeParse(def);
  if (!result.success) {
    console.error(`FAIL ${f}:`);
    for (const i of result.error.issues)
      console.error(`  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    failed++; continue;
  }
  if (def.id !== f.replace(/\.json$/, '')) {
    console.error(`FAIL ${f}: id "${def.id}" must equal filename`); failed++; continue;
  }
  console.log(`PASS ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
NODE

# 2. Command check — every stage.command and gate.onFail.heal must resolve to
#    a ~/.claude/commands/<name>.md file.
missing=0
for f in "$PIPELINES_DIR"/*.json; do
  [[ -e "$f" ]] || continue
  [[ "$(basename "$f")" == ".schema.json" ]] && continue
  while IFS= read -r cmd; do
    [[ -z "$cmd" || "$cmd" == "null" ]] && continue
    if [[ ! -f "$COMMANDS_DIR/${cmd}.md" ]]; then
      echo "FAIL $(basename "$f"): command '$cmd' -> $COMMANDS_DIR/${cmd}.md not found"
      missing=$((missing + 1))
    fi
  done < <(jq -r '
    [ .stages[].command,
      (.stages[].gate | select(.type=="test") | .onFail.heal) ] | .[]' "$f")
done

if (( missing > 0 )); then
  echo "FAIL: $missing missing command file(s)"; exit 1
fi
echo "PASS: all pipelines valid and all commands resolve"
