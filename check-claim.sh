#!/bin/bash
# check-claim.sh — show the current pi extensions tree claim.
# Exit codes:
#   0 = no active claim, or the active claim belongs to this session
#   1 = a DIFFERENT session holds a live claim (younger than 4 hours)
set -u

CLAIM_FILE="$HOME/.pi/agent/extensions/.claimed-by"
CLAIM_TTL_MIN=240

sanitize() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._:@+-' '-' | cut -c1-80
}

current_session_id() {
  if [ -n "${PI_SESSION_ID:-}" ]; then
    sanitize "$PI_SESSION_ID"
    return
  fi
  local tty_raw
  tty_raw=$(ps -o tty= -p "$$" 2>/dev/null | tr -d ' ')
  if [ -z "$tty_raw" ] || [ "$tty_raw" = "??" ]; then
    tty_raw="none"
  fi
  sanitize "tty-$tty_raw"
}

SESSION_ID=$(current_session_id)

if [ ! -f "$CLAIM_FILE" ]; then
  echo "no active claim"
  exit 0
fi

# since_epoch — epoch seconds from the claim's `since:` field.
# Empty output + non-zero exit when the field is absent or unparseable, so the
# caller falls back to mtime. Age MUST come from `since:`: mtime moves whenever
# anything touches the file (incident: a restore bumped mtime and the claim
# read "live" for hours after the holder had finished).
since_epoch() {
  local raw epoch
  raw=$(sed -n 's/^since:[[:space:]]*//p' "$CLAIM_FILE" 2>/dev/null | head -1 | tr -d '[:space:]')
  [ -n "$raw" ] || return 1
  # Strict shape gate: ISO8601 UTC, second granularity (e.g. 2026-09-27T17:38:40Z)
  case "$raw" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$raw" +%s 2>/dev/null) || return 1
  case "$epoch" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$epoch"
}

SINCE_EPOCH=$(since_epoch || true)
if [ -n "$SINCE_EPOCH" ]; then
  age_min=$(( ( $(date +%s) - SINCE_EPOCH ) / 60 ))
  AGE_FALLBACK=""
else
  # Legacy/partial claim file: no usable `since:` → mtime fallback (say so).
  age_min=$(( ( $(date +%s) - $(stat -f %m "$CLAIM_FILE") ) / 60 ))
  AGE_FALLBACK=" — mtime fallback: claim has no usable since: field"
fi
# Clock skew / future `since:` yields a negative age; report as just-claimed.
[ "$age_min" -lt 0 ] && age_min=0

if [ "$age_min" -ge "$CLAIM_TTL_MIN" ]; then
  echo "no active claim (last claim is older than ${CLAIM_TTL_MIN}m${AGE_FALLBACK})"
  exit 0
fi

if grep -qx "session: $SESSION_ID" "$CLAIM_FILE" 2>/dev/null; then
  echo "active claim is yours (age ${age_min}m)${AGE_FALLBACK}:"
  sed 's/^/  /' "$CLAIM_FILE"
  exit 0
fi

echo "active claim held by ANOTHER session (age ${age_min}m)${AGE_FALLBACK} — do not edit concurrently:"
sed 's/^/  /' "$CLAIM_FILE"
exit 1
