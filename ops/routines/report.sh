#!/usr/bin/env bash
# ops/routines/report.sh — the two lines a cloud routine adds. Usage:
#   report.sh start  <unit> <run_key>
#   report.sh finish <unit> <run_key> ok|fail "<summary>" "<evidence url,url>" ["<error>"]
set -euo pipefail
verb=$1; unit=$2; key=$3; shift 3
: "${OPS_TOKEN:?}" "${CORTEX_URL:?}"
case "$CORTEX_URL" in https://*) ;; *) echo "report.sh: CORTEX_URL must use HTTPS" >&2; exit 1 ;; esac
# Preserve the original string instead of deleting newlines or leaving raw controls.
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
if [ "$verb" = start ]; then body=$(printf '{"unit":%s,"verb":"start","run_key":%s,"trigger":"cron"}' "$(json_string "$unit")" "$(json_string "$key")")
else
  ok=$1; summary=${2:-}; ev=${3:-}; err=${4:-}
  evj=""; separator=""
  while [[ -n "$ev" ]]; do
    u=${ev%%,*}
    if [[ -n "$u" ]]; then evj+="$separator$(json_string "$u")"; separator=","; fi
    [[ "$ev" == *,* ]] || break
    ev=${ev#*,}
  done
  body=$(printf '{"unit":%s,"verb":"finish","run_key":%s,"ok":%s,"summary":%s,"evidence":[%s],"error":%s}' "$(json_string "$unit")" "$(json_string "$key")" "$([ "$ok" = ok ] && echo true || echo false)" "$(json_string "$summary")" "$evj" "$(json_string "$err")")
fi
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
code=$(curl -sS --proto '=https' --proto-redir '=https' --max-time 20 -o "$tmp" -w '%{http_code}' -X POST "$CORTEX_URL/api/ops/report" -H "Authorization: Bearer $OPS_TOKEN" -H 'Content-Type: application/json' -d "$body" || echo 000)
cat "$tmp"; echo
case "$code" in 200) exit 0 ;; *) echo "report.sh: $verb $unit returned $code" >&2; exit 1 ;; esac
