#!/usr/bin/env bash
# Health check for a CORTEX deployment. Prints one line; exit 0 = healthy.
#
# Asserts SET EQUALITY against the live tools by name — not a count. A count
# passes with a wrong tool swapped in, and a hardcoded count is exactly what
# silently disabled the reference deployment's nightly upkeep for four days
# after a migration changed the roster.
#
# EXPECTED is DERIVED from lib/tool-roster.json at run time — the one canonical
# roster, pinned to the server by tests/tool-roster.test.ts. This script carried
# its own copy once, went stale behind a new tool, and reported UNHEALTHY
# against a healthy deployment; a verifier that holds its own copy of the fact
# it verifies always ends up lying in one direction or the other.
#
# Configure via env or a file:
#   CORTEX_BASE=https://your-deploy.vercel.app
#   CONNECTOR_PATH_SECRET=...          (or CORTEX_ENV_FILE=path to a dotenv)
set -uo pipefail

if [[ -n "${CORTEX_ENV_FILE:-}" && -r "$CORTEX_ENV_FILE" ]]; then
  CONNECTOR_PATH_SECRET=$(grep '^CONNECTOR_PATH_SECRET=' "$CORTEX_ENV_FILE" | cut -d= -f2)
  CORTEX_BASE=${CORTEX_BASE:-$(grep '^CORTEX_BASE=' "$CORTEX_ENV_FILE" | cut -d= -f2)}
fi
: "${CORTEX_BASE:?set CORTEX_BASE to your deployment URL}"
: "${CONNECTOR_PATH_SECRET:?set CONNECTOR_PATH_SECRET (or CORTEX_ENV_FILE)}"

ROSTER="$(cd "$(dirname "$0")/../.." && pwd)/lib/tool-roster.json"
[[ -r "$ROSTER" ]] || { echo "UNHEALTHY: cannot read $ROSTER — run from a repo checkout"; exit 1; }
EXPECTED="$(node -e 'console.log(require(process.argv[1]).trusted.join(" ") + " ")' "$ROSTER")"
COUNT="$(node -e 'console.log(require(process.argv[1]).trusted.length)' "$ROSTER")"

# HTTPS only, including any redirect a misconfigured deployment might answer with — the URL
# carries a credential, and a downgrade would put it on the wire in the clear.
TOOLS=$(curl -s --max-time 25 --proto '=https' --proto-redir '=https' -X POST "$CORTEX_BASE/api/s/$CONNECTOR_PATH_SECRET/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | grep -o 'brain_[a-z]*' | sort -u | tr '\n' ' ')

if [[ "$TOOLS" == "$EXPECTED" ]]; then
  echo "HEALTHY: secret-URL path OK, ${COUNT} tools registered: ${TOOLS}"
  exit 0
fi
echo "UNHEALTHY: got: ${TOOLS:-<none>} (expected: ${EXPECTED})"
exit 1
