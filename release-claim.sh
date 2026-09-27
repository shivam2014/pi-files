#!/bin/bash
# release-claim.sh [label] [--force] — release the pi extensions tree claim.
# Removes ~/.pi/agent/extensions/.claimed-by so other sessions can take the
# tree. With a label argument it refuses to release a LIVE claim carrying a
# different label (guards against dropping someone else's batch); --force
# overrides. Prints the resulting check-claim.sh state.
#
# Liveness/age come from the `since:` field (mtime fallback), matching
# check-claim.sh — a restore or rsync that bumps mtime must not keep a finished
# claim looking live.
set -u

CLAIM_FILE="$HOME/.pi/agent/extensions/.claimed-by"
CHECK_SCRIPT="$HOME/.pi/check-claim.sh"
CLAIM_TTL_MIN=240

usage() {
  echo "usage: $(basename "$0") [label] [--force]" >&2
  exit 2
}

FORCE=0
LABEL=""
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help) echo "usage: $(basename "$0") [label] [--force]"; exit 0 ;;
    -*) usage ;;
    *)
      if [ -n "$LABEL" ]; then usage; fi
      LABEL="$arg"
      ;;
  esac
done

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

# field_value <name> — first value of a "name: value" claim line, trimmed.
field_value() {
  sed -n "s/^$1:[[:space:]]*//p" "$CLAIM_FILE" 2>/dev/null | head -1 | tr -d '[:space:]'
}

# since_epoch — epoch seconds from `since:`; empty output on missing/garbage.
since_epoch() {
  local raw epoch
  raw=$(field_value since)
  [ -n "$raw" ] || return 1
  case "$raw" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) return 1 ;;
  esac
  epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$raw" +%s 2>/dev/null) || return 1
  case "$epoch" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$epoch"
}

# claim_age_min — age in minutes from `since:`, else mtime fallback.
claim_age_min() {
  local since
  since=$(since_epoch || true)
  if [ -n "$since" ]; then
    echo $(( ( $(date +%s) - since ) / 60 ))
  else
    echo $(( ( $(date +%s) - $(stat -f %m "$CLAIM_FILE") ) / 60 ))
  fi
}

SESSION_ID=$(current_session_id)

if [ ! -f "$CLAIM_FILE" ]; then
  echo "nothing to release: $CLAIM_FILE does not exist"
else
  age_min=$(claim_age_min)
  [ "$age_min" -lt 0 ] && age_min=0

  STATUS="stale"
  [ "$age_min" -lt "$CLAIM_TTL_MIN" ] && STATUS="live"

  HELD_LABEL=$(sanitize "$(field_value label)")
  HELD_SESSION=$(sanitize "$(field_value session)")

  if [ "$STATUS" = "live" ] && [ -n "$LABEL" ] && [ "$FORCE" -eq 0 ] \
     && [ "$(sanitize "$LABEL")" != "$HELD_LABEL" ]; then
    echo "refusing to release: live claim (age ${age_min}m) is '${HELD_LABEL}', not '$(sanitize "$LABEL")' — pass --force to override" >&2
    exit 1
  fi

  if [ "$STATUS" = "live" ] && [ "$HELD_SESSION" != "$SESSION_ID" ]; then
    echo "note: live claim belongs to session ${HELD_SESSION}, not ${SESSION_ID}"
  fi

  rm -f "$CLAIM_FILE"
  echo "released: ${HELD_LABEL:-<no label>} (session ${HELD_SESSION:-unknown}, age ${age_min}m)"
fi

echo ""
if [ -x "$CHECK_SCRIPT" ]; then
  echo "resulting state:"
  "$CHECK_SCRIPT" || true
else
  echo "resulting state: (check-claim.sh not executable at $CHECK_SCRIPT)"
fi
exit 0
