#!/bin/bash
# Deploy the current checkout on the box: rebuild images (cargo/wasm caches make
# this fast when only the frontend changed) and recreate the stack. Invoked by
# CI over SSM after it fast-forwards /opt/interview-pad to origin/main.
set -euxo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

docker compose up -d --build --force-recreate
docker image prune -f >/dev/null 2>&1 || true
docker compose ps
