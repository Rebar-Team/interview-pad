#!/bin/bash
# Pull-based continuous deployment. A systemd timer runs this every minute; when
# origin/main has moved, fast-forward and redeploy. No secrets, no inbound access.
set -uo pipefail
cd /opt/interview-pad || exit 0
git config --global --add safe.directory /opt/interview-pad 2>/dev/null || true
git fetch origin main -q 2>/dev/null || exit 0
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/main 2>/dev/null)
[ -n "$REMOTE" ] || exit 0
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(date -u +%FT%TZ) deploying ${REMOTE:0:7} (was ${LOCAL:0:7})"
  git reset --hard origin/main
  bash scripts/deploy.sh
fi
