#!/usr/bin/env bash
# 클라이언트 enroll 토큰 발급. 인자는 label 하나.
# 예: ./docs/ops/enroll.sh kwonjoosung
set -euo pipefail

if [[ $# -ne 1 || -z "${1:-}" || "$1" == "-h" || "$1" == "--help" ]]; then
  echo "Usage: $0 <label>" >&2
  exit 1
fi

label="$1"
if [[ ! "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "Invalid label: ${label}" >&2
  echo "Use letters, digits, '.', '_' or '-' (must start with alphanumeric)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing ${ROOT}/.env" >&2
  exit 1
fi
if [[ ! -f dist/npx-cli/index.js ]]; then
  echo "Missing dist/npx-cli/index.js — build the CLI first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [[ -z "${CLAUDE_MEM_SERVER_DATABASE_URL:-}" ]]; then
  echo "CLAUDE_MEM_SERVER_DATABASE_URL is not set in .env" >&2
  exit 1
fi

PG_CONTAINER=claude-mem-postgres-1
SERVER_CONTAINER=claude-mem-claude-mem-server-1

PG_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG_CONTAINER")"
if [[ -z "$PG_IP" ]]; then
  echo "Cannot resolve IP for ${PG_CONTAINER} (is the stack up?)" >&2
  exit 1
fi
export CLAUDE_MEM_SERVER_DATABASE_URL="${CLAUDE_MEM_SERVER_DATABASE_URL/@postgres:/@$PG_IP:}"

PORT="$(docker port "$SERVER_CONTAINER" 37700/tcp 2>/dev/null | awk -F: 'NF{print $NF; exit}')"
PORT="${PORT:-37700}"

HOST_IP="$(ip -4 -o addr show scope global | awk '
  $2 !~ /^(lo|docker|br-|veth|tailscale)/ { split($4, a, "/"); print a[1]; exit }
')"
if [[ -z "$HOST_IP" ]]; then
  echo "Cannot detect a LAN IPv4 for the enroll URL." >&2
  exit 1
fi

url="http://${HOST_IP}:${PORT}"
echo "enroll label=${label} url=${url}" >&2
exec node dist/npx-cli/index.js server enroll --url "$url" --label "$label"
