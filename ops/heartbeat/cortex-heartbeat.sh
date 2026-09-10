#!/usr/bin/env bash
# ops/heartbeat/cortex-heartbeat.sh — one POST every 15 minutes: disk, backup, uptime.
# run_key is the UTC *day*, not the minute: applyReport patches the machine's existing row, so
# the ledger keeps one run per day per machine instead of 96 rows nothing ever reads.
# Token lives in ~/.config/cortex/ops.env (mode 600): OPS_TOKEN=..., CORTEX_URL=..., UNIT=workstation
set -euo pipefail
ENV_FILE="$HOME/.config/cortex/ops.env"
[ -r "$ENV_FILE" ] || { echo "cortex-heartbeat: $ENV_FILE missing" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${OPS_TOKEN:?}" "${CORTEX_URL:?}" "${UNIT:=workstation}"
case "$CORTEX_URL" in https://*) ;; *) echo "cortex-heartbeat: CORTEX_URL must use HTTPS" >&2; exit 1 ;; esac
# JSON strings must retain their content, including quotes and control characters.
# Bash cannot carry NUL in an argument; every other JSON control is escaped here.
json_string() {
  local rest=$1 char escaped
  printf '"'
  while [[ -n "$rest" ]]; do
    char=${rest:0:1}; rest=${rest:1}
    case "$char" in
      '"') printf '\\"' ;;
      '\') printf '\\\\' ;;
      $'\n') printf '\\n' ;;
      $'\r') printf '\\r' ;;
      $'\t') printf '\\t' ;;
      [[:cntrl:]]) printf -v escaped '\\u%04x' "'$char"; printf '%s' "$escaped" ;;
      *) printf '%s' "$char" ;;
    esac
  done
  printf '"'
}
disk_pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
uptime_s=$(cut -d. -f1 /proc/uptime)
backup=$(cat "$HOME/.local/state/cortex/backup-last-success" 2>/dev/null || echo "unknown")
sessions=$(pgrep -fc 'claude( |$)' 2>/dev/null || true)
sessions=${sessions:-0}
sessions=${sessions%%$'\n'*}
body=$(printf '{"unit":%s,"verb":"heartbeat","run_key":"hb-%s","facts":{"disk_pct":%s,"uptime_s":%s,"backup":%s,"claude_sessions":%s,"host":%s}}' "$(json_string "$UNIT")" "$(date -u +%Y%m%d)" "$disk_pct" "$uptime_s" "$(json_string "$backup")" "$sessions" "$(json_string "$(hostname)")")
code=$(curl -sS --proto '=https' --proto-redir '=https' -o /dev/null -w '%{http_code}' --max-time 20 -X POST "$CORTEX_URL/api/ops/report" -H "Authorization: Bearer $OPS_TOKEN" -H 'Content-Type: application/json' -d "$body" || echo 000)
case "$code" in 200) exit 0 ;; *) echo "cortex-heartbeat: report returned $code" >&2; exit 1 ;; esac
