#!/usr/bin/env bash
# Health check for a CORTEX deployment. Prints one line; exit 0 = healthy.
#
# Asserts SET EQUALITY against the nine live tools by name — not a count. A count
# passes with a wrong tool swapped in, and a hardcoded count is exactly what
# silently disabled the reference deployment's nightly upkeep for four days
# after a migration changed the roster.
#
# NOTE (2026-08-04): EXPECTED is part of the tool surface. Any change to the
# tools the trusted door registers (lib/tools.ts) must update this roster —
# and the matching check in scripts/onboard.mjs — in the same change.
#
# Configure via env or a file:
#   CORTEX_BASE=https://your-deploy.vercel.app
#   CONNECTOR_PATH_SECRET=...          (or CORTEX_ENV_FILE=path to a dotenv)
set -uo pipefail

if [ -n "${CORTEX_ENV_FILE:-}" ] && [ -r "$CORTEX_ENV_FILE" ]; then
  CONNECTOR_PATH_SECRET=$(grep '^CONNECTOR_PATH_SECRET=' "$CORTEX_ENV_FILE" | cut -d= -f2)
  CORTEX_BASE=${CORTEX_BASE:-$(grep '^CORTEX_BASE=' "$CORTEX_ENV_FILE" | cut -d= -f2)}
fi
: "${CORTEX_BASE:?set CORTEX_BASE to your deployment URL}"
: "${CONNECTOR_PATH_SECRET:?set CONNECTOR_PATH_SECRET (or CORTEX_ENV_FILE)}"

TOOLS=$(curl -s --max-time 25 -X POST "$CORTEX_BASE/api/s/$CONNECTOR_PATH_SECRET/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | grep -o 'brain_[a-z]*' | sort -u | tr '\n' ' ')

EXPECTED="brain_accept brain_ask brain_capture brain_context brain_corpus brain_proposals brain_read brain_reject brain_write "

if [ "$TOOLS" = "$EXPECTED" ]; then
  echo "HEALTHY: secret-URL path OK, 9 tools registered: ${TOOLS}"
  exit 0
fi
echo "UNHEALTHY: got: ${TOOLS:-<none>} (expected: ${EXPECTED})"
exit 1
