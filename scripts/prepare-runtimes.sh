#!/usr/bin/env bash
# Pre-pull the language images ptyd runs, and build the offline TypeScript image.
# Run once on the box (and after changing the language set). Safe to re-run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

IMAGES=(
  "python:3.12-slim"
  "node:22-alpine"
  "eclipse-temurin:21-jdk"
  "golang:1.22-alpine"
  "gcc:14"
)

for img in "${IMAGES[@]}"; do
  echo "==> pulling $img"
  $DOCKER pull "$img"
done

echo "==> building interview-pad-ts:local (TypeScript runtime)"
$DOCKER build -t interview-pad-ts:local "$REPO_DIR/ptyd/runtimes/typescript"

echo "==> done. Runtimes ready."
