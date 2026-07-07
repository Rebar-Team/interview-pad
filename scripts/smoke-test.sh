#!/usr/bin/env bash
#
# End-to-end smoke test for a running InterviewPad deployment.
#
#   ./scripts/smoke-test.sh <domain>          # e.g. interview.example.com
#   ./scripts/smoke-test.sh localhost:80 http # local http (no TLS)
#
# Checks: editor UI loads, Judge0 languages are reachable, and a real Python
# submission compiles+runs and returns the expected stdout.
set -euo pipefail

HOST="${1:?usage: smoke-test.sh <domain> [http|https]}"
SCHEME="${2:-https}"
BASE="${SCHEME}://${HOST}"
fail=0

check() { # <label> <condition-cmd...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok   $label"
  else
    echo "  FAIL $label"; fail=1
  fi
}

echo "==> Testing $BASE"

# 1. Editor UI
check "editor UI responds" bash -c "curl -fsS '$BASE/' | grep -qi 'rustpad\|interviewpad\|<div id=\"root\"\|<script'"

# 2. Judge0 reachable through the /judge0 proxy
check "judge0 /languages reachable" bash -c "curl -fsS '$BASE/judge0/languages' | grep -q '\"id\"'"

# 3. Real execution: run Python that prints a marker, assert stdout.
echo "==> Submitting a Python run..."
PY_ID=$(curl -fsS "$BASE/judge0/languages" \
  | grep -o '{[^{}]*"name"[^{}]*}' \
  | grep -i '"name": *"python (3' | head -1 \
  | grep -o '"id": *[0-9]*' | grep -o '[0-9]*' || true)
PY_ID="${PY_ID:-71}" # fallback to common CE Python 3 id

RESP=$(curl -fsS -X POST \
  "$BASE/judge0/submissions?base64_encoded=false&wait=true" \
  -H 'Content-Type: application/json' \
  -d "{\"language_id\": $PY_ID, \"source_code\": \"print('interviewpad-ok')\"}")

if grep -q "interviewpad-ok" <<<"$RESP"; then
  echo "  ok   python execution (stdout matched)"
else
  echo "  FAIL python execution — response was:"; echo "$RESP" | head -c 800; echo; fail=1
fi

echo
if [[ $fail -eq 0 ]]; then echo "==> All checks passed."; else echo "==> Some checks FAILED."; exit 1; fi
