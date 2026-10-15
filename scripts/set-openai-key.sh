#!/usr/bin/env bash
#
# Set the Interview Assistant's OpenAI key on the production box, from your
# laptop, over SSM (no SSH needed):
#
#   ./scripts/set-openai-key.sh sk-...
#
# Writes OPENAI_API_KEY into /opt/interview-pad/.env (replacing any old value)
# and recreates the rustpad container so it picks the key up. Needs AWS
# credentials for the account that runs the box (set AWS_PROFILE if needed).
#
# Note: SSM keeps command parameters in its command history, so the key is
# sent base64-encoded but is still readable there by account admins.
set -euo pipefail

KEY="${1:-}"
REGION="${REGION:-us-east-1}"

if [[ ! "$KEY" =~ ^sk-[A-Za-z0-9_-]+$ ]]; then
  echo "usage: $0 sk-..." >&2
  exit 1
fi

INSTANCE_ID="${INSTANCE_ID:-$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=interview-pad" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)}"
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == *[[:space:]]* ]]; then
  echo "Expected one running instance tagged Name=interview-pad, found: '${INSTANCE_ID}'." >&2
  echo "Start it, or pass INSTANCE_ID=i-xxxx." >&2
  exit 1
fi

B64="$(printf '%s' "$KEY" | base64 | tr -d '\n')"
REMOTE=$(cat <<EOF
set -e
cd /opt/interview-pad
KEY="\$(echo '$B64' | base64 -d)"
touch .env
if grep -q '^OPENAI_API_KEY=' .env; then
  sed -i "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=\$KEY|" .env
else
  [ -z "\$(tail -c1 .env)" ] || echo >> .env
  echo "OPENAI_API_KEY=\$KEY" >> .env
fi
chmod 600 .env
docker compose up -d rustpad
echo "OPENAI_API_KEY set; rustpad recreated."
EOF
)

PARAMS="$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.stdin.read()]}))' <<<"$REMOTE")"
COMMAND_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Set interview-pad OPENAI_API_KEY" \
  --parameters "$PARAMS" \
  --query Command.CommandId --output text)"

echo "Sent to $INSTANCE_ID; waiting..."
aws ssm wait command-executed --region "$REGION" \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" || true
aws ssm get-command-invocation --region "$REGION" \
  --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" \
  --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
