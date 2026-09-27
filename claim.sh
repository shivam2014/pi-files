#!/bin/bash
# claim.sh <label> — claim the pi extensions tree for this session before editing.
# Writes ~/.pi/agent/extensions/.claimed-by so concurrent sessions can see who owns
# the tree. Idempotent: re-claiming from the same session keeps the original claim.
#
# Claim is considered live for 4 hours (mtime based).
set -u

CLAIM_FILE="$HOME/.pi/agent/extensions/.claimed-by"
CLAIM_TTL_MIN=240

LABEL="${1:-}"
if [ -z "$LABEL" ]; then
  echo "usage: $(basename "$0") <label>" >&2
  exit 2
fi

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
LABEL_CLEAN=$(sanitize "$LABEL")

# Show any existing live claim before (re)writing ours.
if [ -f "$CLAIM_FILE" ]; then
  if [ -n "$(find "$CLAIM_FILE" -mmin -"$CLAIM_TTL_MIN" 2>/dev/null)" ]; then
    age_min=$(( ( $(date +%s) - $(stat -f %m "$CLAIM_FILE") ) / 60 ))
    echo "existing claim (age ${age_min}m, live for ${CLAIM_TTL_MIN}m):"
    sed 's/^/  /' "$CLAIM_FILE"
    if grep -qx "session: $SESSION_ID" "$CLAIM_FILE" 2>/dev/null; then
      echo "already claimed by this session ($SESSION_ID) — leaving claim unchanged."
      exit 0
    fi
  else
    echo "existing claim is stale (older than ${CLAIM_TTL_MIN}m) — overwriting."
  fi
fi

{
  echo "label: $LABEL_CLEAN"
  echo "session: $SESSION_ID"
  echo "pid: $$"
  echo "since: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$CLAIM_FILE"

echo "claimed: $LABEL_CLEAN (session $SESSION_ID, pid $$)"
