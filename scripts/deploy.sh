#!/bin/bash
# Deploy the current checkout on the box: rebuild images (cargo/wasm caches make
# this fast when only the frontend changed) and recreate the stack. Invoked by
# scripts/autodeploy.sh (systemd timer) after it fast-forwards to origin/main.
set -euxo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

# Refuse to ship sign-in without its config: rooms can only be created by a
# signed-in interviewer, so a deploy without it would lock everyone out.
set +x
for var in SESSION_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  value="$(grep -E "^${var}=" .env 2>/dev/null | tail -n1 | cut -d= -f2-)"
  if [ -z "$value" ]; then
    echo "deploy: ${var} is empty in .env; see DEPLOY.md (Google sign-in). Not deploying." >&2
    exit 1
  fi
done
secret="$(grep -E '^SESSION_SECRET=' .env | tail -n1 | cut -d= -f2-)"
if [ "${#secret}" -lt 32 ]; then
  echo "deploy: SESSION_SECRET must be at least 32 characters. Not deploying." >&2
  exit 1
fi
set -x

docker compose up -d --build --force-recreate
docker image prune -f >/dev/null 2>&1 || true
docker compose ps
