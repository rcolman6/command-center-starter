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
