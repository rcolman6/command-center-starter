Read specs/00-system-map.md first.

This is the Command Center: a Captain-reviewed, cron-driven autonomous task system.
The dashboard (Next.js) runs on http://localhost:18525; JSON files under `dashboard/data/` are the database.
The worker is `workers/run-worker.sh`, fired by cron, which claims a task, runs Claude, and records the result.
The specs in `specs/` are the source of truth — when in doubt, defer to them.

Note: this instance is configured to run on port **18525** (front + back) to avoid colliding
with another Command Center on the default 18424. The `specs/` files still document 18424 as
the canonical default; everything operational here (dashboard, worker, slash commands) uses 18525.
