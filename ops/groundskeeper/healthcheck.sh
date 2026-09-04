#!/usr/bin/env bash
# Health check for a CORTEX deployment. Prints a HEALTHY/UNHEALTHY line —
# plus, on a healthy night, an UPDATE AVAILABLE line when a newer release is
# published upstream. Exit 0 = healthy; being behind a release never flips
# the exit code, because a deployment behind main still answers correctly.
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
# ...and not on the command line either: interpolated here the secret is visible to `ps` and
# to shell audit logs. printf is a builtin, so the URL never becomes another process's argv;
# curl reads it as a config on stdin.
TOOLS=$(printf 'url = "%s/api/s/%s/mcp"\n' "$CORTEX_BASE" "$CONNECTOR_PATH_SECRET" \
  | curl -s --max-time 25 --proto '=https' --proto-redir '=https' -X POST -K - \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  | grep -o 'brain_[a-z]*' | sort -u | tr '\n' ' ')

if [[ "$TOOLS" == "$EXPECTED" ]]; then
  echo "HEALTHY: secret-URL path OK, ${COUNT} tools registered: ${TOOLS}"
  # Update awareness, not health. One unauthenticated GET of public release
  # metadata — nothing about this deployment goes out. Absence on any failure:
  # an update note this script cannot prove is worse than no note. The compare
  # runs in node rather than sort -V, which macOS's BSD sort does not promise.
  UPDATE_LINE=$(node -e '
    const running = require(process.argv[1]).version;
    fetch("https://api.github.com/repos/Obelyth/cortex/releases/latest",
      { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const m = /^v(\d+\.\d+\.\d+)$/.exec((j && j.tag_name) || "");
        if (!m) return;
        const latest = m[1].split(".").map(Number), run = running.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((latest[i] ?? 0) > (run[i] ?? 0)) {
            console.log("UPDATE AVAILABLE: v" + m[1] + " (running v" + running + ") — npm run update");
            return;
          }
          if ((latest[i] ?? 0) < (run[i] ?? 0)) return;
        }
      })
      .catch(() => {});
  ' "$(cd "$(dirname "$0")/../.." && pwd)/package.json" 2>/dev/null)
  [[ -n "$UPDATE_LINE" ]] && echo "$UPDATE_LINE"
  exit 0
fi
echo "UNHEALTHY: got: ${TOOLS:-<none>} (expected: ${EXPECTED})"
exit 1
