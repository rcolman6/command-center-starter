# Config and Cron

> Two config files and the machinery that turns one of them into a real crontab entry. `config/paths.json` is the single source of truth for external paths — never hardcode one. `dashboard/data/cron-config.json` is the worker switch and heartbeat record. The `/settings` page — never your hand — drives the crontab. Defers to `00-system-map.md` and `01-foundation.md`; if anything here disagrees with those, they win. If anything here disagrees with the code, the code wins and this file is fixed.

---

## What

This spec owns **config and cron** — the two things that sit *around* the worker rather than inside it:

1. **External paths** live in exactly one file, `config/paths.json`. No absolute path that points outside this repo is ever hardcoded in a script, slash command, or page (Invariant 4 from the system map). Adding a project to the system is adding an entry here, not a code change.
2. **The cron tick** fires the worker every N minutes. The installed crontab line wraps `workers/run-worker.sh` and is installed/removed idempotently via a marker comment.
3. **The Settings page** toggles the worker on/off and sets the interval. Flipping the toggle reconciles the real crontab — the Captain never edits crontab by hand.
4. **The heartbeat.** Every tick the worker stamps `lastRun` / `lastTaskId` into `cron-config.json` so the Settings page can show liveness.

**What this owns vs. what it doesn't.** This file owns the *switch and the wiring*: the path registry, the crontab install/remove logic, the Settings UI + its API route, and the cron-config schema. It does **not** own the claim-run-record loop itself (that is `02-worker-system.md`), the run-health log (`06-observability.md`), or the pipeline engine (`05-pipelines.md`). The worker only appears here as the thing the cron line invokes and the thing that writes the heartbeat.

A second, separate trigger also lives in `scripts/` — `scripts/trigger-pipeline.sh`, which a *per-pipeline* cron line can fire to start a pipeline run. That is independent of the worker-loop cron installed by this spec; see §6.

---

## Where

Every path below was verified to exist in this repo.

| File | Role |
|------|------|
| `config/paths.json` | The single home for external absolute paths. Read by scripts/slash commands; never duplicated. |
| `dashboard/data/cron-config.json` | The worker switch + heartbeat record. Read/written by both the Settings API and the worker. |
| `dashboard/lib/cron.ts` | The only code that mutates the real crontab. `installCron` / `removeCron` / `buildCronExpression`. |
| `scripts/install-cron.sh` | CLI equivalent of `installCron` — install/replace/remove the worker cron line from the terminal. |
| `dashboard/app/settings/page.tsx` | The `/settings` client page: enabled toggle, interval dropdown, read-only last-run. |
| `dashboard/app/api/cron-config/route.ts` | `GET`/`PUT` for cron-config; the `PUT` reconciles the crontab via `dashboard/lib/cron.ts`. |
| `scripts/trigger-pipeline.sh` | Separate trigger: POSTs `{pipelineId}` to the dashboard to start a pipeline run (see §6). |
| `workers/run-worker.sh` | Not owned here. Referenced as the cron target and the writer of `lastRun`/`lastTaskId` (and cooldown keys). |
| `scripts/lib/log-run.sh` | Not owned here (lives in `06-observability.md`). The installed cron line does **not** route through it (see §3). |

---

## How

### 1. `config/paths.json` — the single source of truth for external paths

**The rule (Invariant 4): no absolute path is ever hardcoded.** Every path that points outside this repo lives here. Slash commands and scripts read it with `jq`. **Adding a new project is adding an entry — not a code change.** When you move a folder, you edit one line, not a grep across the codebase.

The actual file in this repo:

```json
{
  "projects": {
    "command-center": {
      "path": "/home/romij/claude_accessible/command-center",
      "defaultBranch": "main"
    }
  },
  "knowledgeBase": "/home/romij/notes",
  "outputs": "workers/workspace/outputs"
}
```

The three keys this repo uses (the rule is the constraint; you add `projects` entries as you grow):

- `projects.<id>.path` / `.defaultBranch` — repos the worker operates on. A slash command does `jq -r '.projects["command-center"].path' config/paths.json` and `cd`s there. No absolute path ever appears in the command file itself.
- `knowledgeBase` — where your reference material / vault lives, if a command needs to read it.
- `outputs` — repo-relative; where deliverables land. Keep it relative so the repo stays portable.

**Why this matters:** the value of the whole system is Layer 3 (your automations), which are just slash commands plus paths. Centralized paths make a command portable and a new project a one-line diff. Scattered paths make every move a refactor.

---

### 2. `dashboard/data/cron-config.json` — the worker switch + heartbeat

The on/off switch and the heartbeat record. The committed file in this repo:

```json
{
  "enabled": true,
  "intervalMinutes": 5,
  "lastRun": "2026-06-01T17:20:01Z",
  "lastTaskId": "task-1780332999345-d6mjom"
}
```

| Key | Type | Who writes it | Meaning |
|-----|------|---------------|---------|
| `enabled` | `boolean` | Settings UI (`PUT`) | Is the worker installed on cron? |
| `intervalMinutes` | `number` | Settings UI (`PUT`) | How often it fires. One of `5 / 10 / 15 / 30 / 60`. |
| `lastRun` | `string \| null` | the worker, each tick | ISO timestamp of the last tick. The "is it alive?" signal. |
| `lastTaskId` | `string \| null` | the worker, when it claims a task | The id of the task claimed last tick. Left unchanged on a no-op tick. |

**Two optional keys the worker may add.** On a provider rate-limit / usage-limit hit, `workers/run-worker.sh` writes two more keys and clears them when the cooldown expires:

| Key | Type | Who writes it | Meaning |
|-----|------|---------------|---------|
| `cooldownUntil` | `string` | the worker, on a 429 | ISO timestamp until which every tick stands down. Cleared automatically once elapsed. |
| `cooldownReason` | `string` | the worker, on a 429 | A copy-pasteable blurb explaining the pause (surfaced as a dashboard banner). |

These are absent in steady state; treat them as ephemeral worker state, not a UI-managed setting. See `02-worker-system.md` for the cooldown logic.

**Three writers, separate lanes.** The **worker** updates `lastRun` / `lastTaskId` every tick (and `cooldownUntil` / `cooldownReason` only on a 429). The **Settings UI** writes only `enabled` / `intervalMinutes`. They never collide on the same keys. `lastRun` going stale (older than ~2× the interval) while `enabled` is true means the worker is dead — that's your one health check.

---

### 3. `dashboard/lib/cron.ts` — installs/removes the crontab entry

The only code that touches your real crontab. It is idempotent: every install **replaces** the prior line, every remove **deletes** it. A marker comment — `# COMMAND-CENTER-WORKER` — is appended to our line so install/remove can find and strip exactly our entry and leave every other cron job untouched.

The installed line (one line, marker at the end):

```
*/5 * * * * cd /abs/path/to/command-center && bash workers/run-worker.sh >> workers/logs/cron.log 2>&1 # COMMAND-CENTER-WORKER
```

Note: the line invokes `workers/run-worker.sh` **directly** and redirects to `workers/logs/cron.log`. It does **not** route through `scripts/lib/log-run.sh` — wrapping the cron line in that health logger is an optional enhancement documented in `06-observability.md`, not what this installer emits.

The module exports three functions; `REPO_DIR` is the one place an absolute path is allowed in code (crontab runs with no working directory):

```ts
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MARKER = '# COMMAND-CENTER-WORKER';
// Absolute path to THIS repo — the one place an abs path is allowed in code.
const REPO_DIR = '/abs/path/to/command-center';

const WORKER_CMD =
  `cd ${REPO_DIR} && bash workers/run-worker.sh >> workers/logs/cron.log 2>&1`;

/** <60 -> every N min; ==60 -> top of every hour; >60 (mult of 60) -> every H hours. */
export function buildCronExpression(intervalMinutes: number): string {
  return intervalMinutes < 60
    ? `*/${intervalMinutes} * * * *`
    : intervalMinutes === 60
      ? '0 * * * *'
      : `0 */${intervalMinutes / 60} * * *`;
}

/** Read the current crontab. Empty string if none exists (a fresh box has no crontab). */
async function readCrontab(): Promise<string> {
  try {
    const { stdout } = await execAsync('crontab -l 2>/dev/null');
    return stdout;
  } catch {
    return '';
  }
}

/** Write a crontab from a string via `crontab -` (stdin). Empty content removes it. */
async function writeCrontab(content: string): Promise<void> {
  const trimmed = content.trim();
  if (trimmed === '') {
    try { await execAsync('crontab -r 2>/dev/null'); } catch { /* already empty */ }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('crontab', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || `crontab exit ${code}`)));
    child.stdin.end(`${trimmed}\n`);
  });
}

/** Install (or replace) our cron line at the given interval. */
export async function installCron(intervalMinutes: number): Promise<void> {
  const current = await readCrontab();
  // Strip any prior COMMAND-CENTER line, keep everything else.
  const lines = current.split('\n').filter((l) => !l.includes(MARKER));
  lines.push(`${buildCronExpression(intervalMinutes)} ${WORKER_CMD} ${MARKER}`);
  await writeCrontab(lines.filter((l) => l.trim() !== '').join('\n'));
}

/** Remove our cron line; leave the rest of the crontab intact. */
export async function removeCron(): Promise<void> {
  const current = await readCrontab();
  const lines = current.split('\n').filter((l) => !l.includes(MARKER));
  await writeCrontab(lines.filter((l) => l.trim() !== '').join('\n'));
}
```

**The two things to internalize:**
- **The marker makes it idempotent.** Install = strip-then-append, so running it ten times leaves one line. Remove = strip. No duplicates, no clobbering unrelated cron jobs.
- **The crontab is the one unavoidable out-of-repo side effect.** Everything else this system does lives inside the repo (JSON files, a workspace dir). The crontab is the single exception — it's machine state. That's why install/remove must be surgical and reversible.

---

### 4. The `/settings` page + `/api/cron-config` route

The Captain never edits crontab by hand. **Flipping the toggle in the UI installs or removes the actual crontab entry.** The page is three controls; the route is the muscle.

#### `/settings` (`dashboard/app/settings/page.tsx`)

A client component that loads `GET /api/cron-config` and renders:

- a **toggle** bound to `enabled`,
- a **dropdown** bound to `intervalMinutes` (`5 / 10 / 15 / 30 / 60`),
- read-only text showing `lastRun` ("Last run: 3 min ago" / "never") plus `lastTaskId` when present.

On any change it `PUT`s `{ enabled, intervalMinutes }`, then reloads. The displayed `lastRun` is your liveness check — stale while `enabled` is true means the worker isn't firing.

#### `GET` / `PUT /api/cron-config` (`dashboard/app/api/cron-config/route.ts`)

`GET` returns the whole file. `PUT` writes the file first, then reconciles the crontab against the change. `CFG` resolves to `data/cron-config.json` relative to the dashboard's cwd.

```ts
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { installCron, removeCron } from '@/lib/cron';

const CFG = path.join(process.cwd(), 'data', 'cron-config.json');

async function read() {
  return JSON.parse(await fs.readFile(CFG, 'utf8'));
}

export async function GET() {
  return NextResponse.json(await read());
}

export async function PUT(req: Request) {
  const prev = await read();
  const body = await req.json(); // { enabled, intervalMinutes }

  const next = {
    ...prev,
    enabled: body.enabled ?? prev.enabled,
    intervalMinutes: body.intervalMinutes ?? prev.intervalMinutes,
  };
  // Worker-owned keys (lastRun/lastTaskId, cooldown*) are never touched here.
  await fs.writeFile(CFG, JSON.stringify(next, null, 2));

  // Reconcile the real crontab with the new desired state.
  const turnedOn      = next.enabled && !prev.enabled;
  const intervalMoved = next.enabled && next.intervalMinutes !== prev.intervalMinutes;
  const turnedOff     = !next.enabled && prev.enabled;

  if (turnedOff)                      await removeCron();
  else if (turnedOn || intervalMoved) await installCron(next.intervalMinutes);

  return NextResponse.json(next);
}
```

The reconcile logic is the whole point: **enabled went true (or the interval changed) → `installCron`; enabled went false → `removeCron`.** The JSON file is desired state; the crontab is reconciled to match it on every write. The `{ ...prev }` spread preserves worker-owned keys — the route only ever sets `enabled` / `intervalMinutes`. The UI never knows crontab exists; it just toggles a boolean.

---

### 5. `scripts/install-cron.sh` — the CLI installer

Same marker, same line, same idempotency — for Captains who'd rather install from the terminal than click the toggle. The UI and this script are interchangeable; both converge on one marked line.

```bash
#!/usr/bin/env bash
# Install the Command Center worker on cron. Idempotent: re-running replaces the line.
# Usage: bash scripts/install-cron.sh [interval_minutes]   (default 5)
#        bash scripts/install-cron.sh --remove
set -euo pipefail

MARKER="# COMMAND-CENTER-WORKER"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root, absolute
CMD="cd $REPO_DIR && bash workers/run-worker.sh >> workers/logs/cron.log 2>&1"

# Current crontab minus our line (tolerate "no crontab" -> empty).
existing="$(crontab -l 2>/dev/null | grep -vF "$MARKER" || true)"

if [[ "${1:-}" == "--remove" ]]; then
  printf '%s\n' "$existing" | grep -v '^[[:space:]]*$' | crontab -
  echo "Removed worker cron entry."
  exit 0
fi

minutes="${1:-5}"
if   (( minutes < 60 )); then expr="*/$minutes * * * *"
elif (( minutes == 60 )); then expr="0 * * * *"
else expr="0 */$(( minutes / 60 )) * * *"
fi

mkdir -p "$REPO_DIR/workers/logs"
{ printf '%s\n' "$existing" | grep -v '^[[:space:]]*$' || true; \
  echo "$expr $CMD $MARKER"; } | crontab -
echo "Installed: $expr (every $minutes min)"
crontab -l | grep -F "$MARKER"
```

Unlike the TS module, this script derives `REPO_DIR` from its own location, so no path is hardcoded. `grep -vF "$MARKER"` strips our prior line; `grep -v '^[[:space:]]*$'` drops blank lines so piping to `crontab -` stays clean. Run it again with a new interval and it replaces; run `--remove` and it's gone.

---

### 6. Two cron lanes — the worker loop vs. per-pipeline triggers

There are two *different* kinds of cron entry, and only the first is installed by this spec's tooling.

**Lane A — the worker loop (this spec).** One marked line, installed by `installCron` / `install-cron.sh`, fires `workers/run-worker.sh` every N minutes. It claims the highest-priority pending task and runs it. This is the spine's heartbeat.

**Lane B — per-pipeline triggers (separate).** `scripts/trigger-pipeline.sh <pipeline-id>` POSTs `{"pipelineId":"<id>"}` to the dashboard's `/api/pipeline-runs` endpoint to *start a pipeline run* on a schedule. A pipeline's own cron line invokes this script; the `/setup-pipeline` skill installs such triggers. It does **not** use the `# COMMAND-CENTER-WORKER` marker and is independent of the worker-loop install/remove above.

```bash
#!/usr/bin/env bash
# scripts/trigger-pipeline.sh — start a pipeline run.
# Usage: trigger-pipeline.sh <pipeline-id>
set -euo pipefail

PIPELINE_ID="$1"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:18525}"

curl -fsS -X POST "${DASHBOARD_URL}/api/pipeline-runs" \
  -H 'Content-Type: application/json' \
  -d "{\"pipelineId\":\"${PIPELINE_ID}\"}"
```

Note the operational port: this script defaults `DASHBOARD_URL` to `http://localhost:18525` (this instance's port), overridable via the `DASHBOARD_URL` env var. The canonical default documented across the spec pack is `18424`.

---

### 7. Wiring recap — how a tick becomes work

The crontab line is the trigger; everything after it is the loop from `02-worker-system.md`:

```
cron fires (every N min, Lane A)
   └─> cd command-center && bash workers/run-worker.sh
          └─> stands down if a rate-limit cooldown is still active
          └─> takes the lock (one worker at a time)
          └─> GET /api/tasks  → claims lowest-priority/oldest `pending` task → in_progress
          └─> runs Claude with the task's slash command (the HOW)
          └─> writes deliverables to workspace/outputs/{id}/
          └─> PATCHes status → needs_review (or completed in autoMode) — the Captain's gate
          └─> updates cron-config.lastRun / lastTaskId  ← the heartbeat
```

That heartbeat write closes the circle: the same `cron-config.json` the Settings toggle uses to *start* the worker is the file the worker stamps to prove it's *alive*. The Settings UI writes `enabled` / `intervalMinutes` going in; the worker writes `lastRun` / `lastTaskId` coming out (and `cooldownUntil` / `cooldownReason` on a 429). Full loop detail — claim rules, failure revert, the revision path, the cooldown — lives in `02-worker-system.md`.
