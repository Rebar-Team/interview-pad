#!/usr/bin/env bash
#
# One-shot EC2 (Ubuntu 22.04 x86_64) setup for RebarPad. Run with sudo:
#
#   sudo ./scripts/setup-host.sh <DOMAIN> [ACME_EMAIL]
#
# Installs Docker, writes .env, pulls language runtimes, installs the boot +
# auto-deploy systemd units, and starts the stack. Idempotent.
set -euo pipefail

DOMAIN="${1:-}"
ACME_EMAIL="${2:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script targets a Linux host (EC2). Aborting." >&2
  exit 1
fi

# --- 1. Docker (official script: reliable compose plugin across distros) -----
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq git ca-certificates curl
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# --- 2. Config ---------------------------------------------------------------
if [[ ! -f .env ]]; then
  [[ -n "$DOMAIN" ]] || { echo "First run needs: setup-host.sh <DOMAIN> [ACME_EMAIL]" >&2; exit 1; }
  cp .env.example .env
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  sed -i "s|^ACME_EMAIL=.*|ACME_EMAIL=${ACME_EMAIL}|" .env
  echo "==> Wrote .env (DOMAIN=${DOMAIN})."
fi

# --- 3. Language runtimes ----------------------------------------------------
echo "==> Preparing language runtimes (pull images + build TypeScript runtime)..."
./scripts/prepare-runtimes.sh

# --- 4. systemd: bring the stack up on boot + pull-based CD ------------------
echo "==> Installing systemd units..."
cat >/etc/systemd/system/interview-pad.service <<UNIT
[Unit]
Description=RebarPad stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/docker compose up -d
[Install]
WantedBy=multi-user.target
UNIT
cp scripts/systemd/interview-pad-autodeploy.service /etc/systemd/system/
cp scripts/systemd/interview-pad-autodeploy.timer /etc/systemd/system/
git config --global --add safe.directory "${REPO_DIR}" || true
systemctl daemon-reload
systemctl enable interview-pad.service
systemctl enable --now interview-pad-autodeploy.timer

# --- 5. Bring up -------------------------------------------------------------
echo "==> Building and starting the stack..."
docker compose up -d --build

echo
echo "==> Up. Point a Cloudflare A record (grey cloud) at this box's Elastic IP"
echo "    for \"$DOMAIN\", then open https://$DOMAIN (first request provisions TLS)."
echo "    CD is live: pushes to origin/main auto-deploy within ~60s."
