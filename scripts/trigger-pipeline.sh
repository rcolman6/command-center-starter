#!/usr/bin/env bash
# scripts/trigger-pipeline.sh — start a pipeline run.
# Usage: trigger-pipeline.sh <pipeline-id>
# POSTs {"pipelineId":"<id>"} to the dashboard's pipeline-runs API. This is the
# concrete command a cron pipeline runs, and what the /setup-pipeline skill
# references when it installs a cron trigger.
set -euo pipefail

if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "Usage: trigger-pipeline.sh <pipeline-id>" >&2
  exit 2
fi

PIPELINE_ID="$1"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:18525}"

curl -fsS -X POST "${DASHBOARD_URL}/api/pipeline-runs" \
  -H 'Content-Type: application/json' \
  -d "{\"pipelineId\":\"${PIPELINE_ID}\"}"
