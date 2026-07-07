#!/usr/bin/env bash
#
# One-shot EC2 (Ubuntu 22.04 x86_64) setup for InterviewPad.
#
#   ./scripts/setup-host.sh <DOMAIN> [ACME_EMAIL]
#
# Run it once. If the host is still on cgroup v2 (Ubuntu default) it switches to
# v1 — which Judge0 requires — and reboots. Re-run the same command after the
# reboot and it will finish: install Docker, generate secrets, and start the
# stack. Idempotent: safe to run repeatedly.
set -euo pipefail

DOMAIN="${1:-}"
ACME_EMAIL="${2:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script targets a Linux host (EC2). Aborting." >&2
  exit 1
fi

# --- 1. cgroup v1 (required by Judge0's isolate) -----------------------------
if [[ "$(stat -fc %T /sys/fs/cgroup/ 2>/dev/null)" == "cgroup2fs" ]]; then
  echo "==> Host is on cgroup v2; switching to v1 for Judge0..."
  sudo sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 systemd.unified_cgroup_hierarchy=0"/' /etc/default/grub
  sudo update-grub
  echo
  echo "==> Rebooting to apply cgroup v1. After it comes back, re-run:"
  echo "    ./scripts/setup-host.sh \"$DOMAIN\" \"$ACME_EMAIL\""
  sudo reboot
  exit 0
fi
echo "==> cgroup v1 active."

# --- 2. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker.io docker-compose-v2 git
  sudo usermod -aG docker "$USER" || true
fi
# Use sudo for docker if the current shell isn't in the docker group yet.
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# --- 3. Config + secrets -----------------------------------------------------
if [[ ! -f .env ]]; then
  [[ -n "$DOMAIN" ]] || { echo "First run needs: setup-host.sh <DOMAIN> [ACME_EMAIL]" >&2; exit 1; }
  cp .env.example .env
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${ACME_EMAIL}|" .env
  echo "==> Wrote .env (DOMAIN=${DOMAIN})."
fi

# --- 4. Language runtimes ----------------------------------------------------
echo "==> Preparing language runtimes (pull images + build TypeScript runtime)..."
./scripts/prepare-runtimes.sh

# --- 5. Bring up -------------------------------------------------------------
echo "==> Building and starting the stack..."
$DOCKER compose up -d --build

echo
echo "==> Up. Point a Cloudflare A record (grey cloud) at this box's IP for \"$DOMAIN\","
echo "    then open https://$DOMAIN  (first request provisions the TLS cert)."
echo "    Verify end-to-end with: ./scripts/smoke-test.sh $DOMAIN"
