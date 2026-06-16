#!/usr/bin/env bash
# tui-smoke.sh — Automated TUI smoke tests for the pi orchestrator extension
# Uses tmux to drive a pi session and validate TUI rendering.
#
# Usage:
#   ./tui-smoke.sh [PI_BINARY] [TEST_PROMPT]
#
# Environment:
#   PI_BIN          — path to pi binary (default: pi)
#   TEST_TIMEOUT    — per-test timeout in seconds (default: 45)
#   TOTAL_TIMEOUT   — total script timeout in seconds (default: 120)
#   CAPTURE_DIR     — directory for captures (default: /tmp/tui-smoke-XXXXXX)
#   TMUX_SESSION    — tmux session name (default: tui-smoke-$$)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PI_BIN="${1:-${PI_BIN:-pi}}"
TEST_PROMPT="${2:-${TEST_PROMPT:-add error handling to main.ts}}"
TEST_TIMEOUT="${TEST_TIMEOUT:-60}"
TOTAL_TIMEOUT="${TOTAL_TIMEOUT:-180}"
TMUX_SESSION="${TMUX_SESSION:-tui-smoke-$$}"
TMUX_COLS=80
TMUX_ROWS=50

export PI_TUI_DEBUG=1
export PI_TUI_WRITE_LOG=/tmp/tui/smoke-capture.log
export PI_DEBUG_REDRAW=1

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
CAPTURE_DIR="${CAPTURE_DIR:-$(mktemp -d /tmp/tui-smoke-XXXXXX)}"
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_TESTS=0
TEST_RESULTS=()
CLEANED_UP=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { printf '[tui-smoke] %s\n' "$*"; }
pass() { printf '  ✓ %s\n' "$*"; PASS_COUNT=$((PASS_COUNT + 1)); TEST_RESULTS+=("PASS: $*"); }
fail() { printf '  ✗ %s\n' "$*"; FAIL_COUNT=$((FAIL_COUNT + 1)); TEST_RESULTS+=("FAIL: $*"); }

# capture — snapshot the current tmux pane into CAPTURE_TEXT
capture() {
  CAPTURE_TEXT="$(tmux capture-pane -t "$TMUX_SESSION" -p -S -100 2>/dev/null || true)"
}

# wait_for_text — poll tmux pane until $1 appears (or timeout)
#   $1 = pattern (grep -E)
#   $2 = timeout seconds (default: TEST_TIMEOUT)
wait_for_text() {
  local pattern="$1"
  local timeout="${2:-$TEST_TIMEOUT}"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    capture
    if echo "$CAPTURE_TEXT" | grep -qE "$pattern"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# wait_until_stable — wait until the pane content stops changing for N seconds
wait_until_stable() {
  local stable_secs="${1:-5}"
  local timeout="${2:-$TEST_TIMEOUT}"
  local prev=""
  local stable=0
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    capture
    if [ "$CAPTURE_TEXT" = "$prev" ]; then
      stable=$((stable + 1))
      if [ "$stable" -ge "$stable_secs" ]; then
        return 0
      fi
    else
      stable=0
    fi
    prev="$CAPTURE_TEXT"
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

# send_keys — send a string to tmux pane
send_keys() {
  tmux send-keys -t "$TMUX_SESSION" -- "$1"
  sleep 0.3
  tmux send-keys -t "$TMUX_SESSION" Enter
}

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then return; fi
  CLEANED_UP=1
  log "Cleaning up..."
  # Kill the tmux session if it still exists
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  # Archive captures
  log "Captures saved to: $CAPTURE_DIR"
  # Archive debug logs
  if [ -d /tmp/tui ]; then
    cp -r /tmp/tui/* "$CAPTURE_DIR/" 2>/dev/null || true
  fi
  log "════════════════════════════════════════"
  log "  Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed (${TOTAL_TESTS} total)"
  log "════════════════════════════════════════"
  for r in "${TEST_RESULTS[@]}"; do
    log "  $r"
  done
  log "════════════════════════════════════════"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    exit 1
  else
    exit 0
  fi
}

trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
log "TUI Smoke Test — orchestrator extension"
log "─────────────────────────────────────────"
log "Binary:    $PI_BIN"
log "Prompt:    $TEST_PROMPT"
log "Session:   $TMUX_SESSION"
log "Captures:  $CAPTURE_DIR"
log "Timeout:   ${TEST_TIMEOUT}s per test, ${TOTAL_TIMEOUT}s total"
log ""

# Ensure tmux is available
if ! command -v tmux &>/dev/null; then
  log "FATAL: tmux not found in PATH"
  exit 2
fi

# Ensure pi binary is available
if ! command -v "$PI_BIN" &>/dev/null; then
  log "FATAL: pi binary not found: $PI_BIN"
  exit 2
fi

# Ensure PI_TUI_WRITE_LOG directory exists
mkdir -p "$(dirname "$PI_TUI_WRITE_LOG")" 2>/dev/null || true
rm -f "$PI_TUI_WRITE_LOG" 2>/dev/null || true

# Clean previous debug logs
rm -rf /tmp/tui/render-*.log 2>/dev/null || true

# ---------------------------------------------------------------------------
# Start tmux + pi
# ---------------------------------------------------------------------------
log "Starting pi in tmux session..."

# Explicitly unset PI_ORCHESTRATOR_SUBAGENT to prevent subagent context leak
# from orchestrator extension (env var causes extension to skip registration)
tmux new-session -d -s "$TMUX_SESSION" -x "$TMUX_COLS" -y "$TMUX_ROWS" \
  "PI_ORCHESTRATOR_SUBAGENT= PI_TUI_DEBUG=$PI_TUI_DEBUG PI_TUI_WRITE_LOG=$PI_TUI_WRITE_LOG PI_DEBUG_REDRAW=$PI_DEBUG_REDRAW $PI_BIN"

# Give pi time to initialize
log "Waiting for pi to initialize (${TEST_TIMEOUT}s max)..."
if ! wait_for_text '(Chat|Model|Ready|pi|$|›)' 20; then
  log "WARNING: Could not confirm pi startup prompt; proceeding anyway"
fi

# Small extra settle
sleep 2
capture
# Save startup snapshot
echo "$CAPTURE_TEXT" > "$CAPTURE_DIR/00-startup.txt"

# ════════════════════════════════════════════════════════════════════════════
# Test Cases
# ════════════════════════════════════════════════════════════════════════════

# ── test_startup ────────────────────────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_startup ──"
log "Checking pi started without TUI crashes..."

CRASH_LOG=$(find /tmp -maxdepth 3 -name "*.crash" -o -name "crash*" 2>/dev/null | head -5 || true)
if [ -n "$CRASH_LOG" ]; then
  fail "Crash logs found: $CRASH_LOG"
else
  pass "No crash logs found on startup"
fi

# ── test_render_log_exists ──────────────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_render_log_exists ──"
log "Checking PI_TUI_DEBUG generated render logs..."

RENDER_LOGS=$(find /tmp/tui -maxdepth 1 -name "render-*.log" 2>/dev/null | head -10 || true)
if [ -n "$RENDER_LOGS" ]; then
  LOG_COUNT=$(echo "$RENDER_LOGS" | wc -l | tr -d ' ')
  pass "Found ${LOG_COUNT} render log(s)"
else
  # Some versions may write to write-log instead
  if [ -f "$PI_TUI_WRITE_LOG" ] && [ -s "$PI_TUI_WRITE_LOG" ]; then
    pass "Found write log: $PI_TUI_WRITE_LOG"
  else
    fail "No render logs or write log found"
  fi
fi

# ── Send the test prompt ───────────────────────────────────────────────────
log ""
log "Sending test prompt: $TEST_PROMPT"
send_keys "$TEST_PROMPT"

# Give the orchestrator time to kick in
log "Waiting for orchestrator response (${TEST_TIMEOUT}s max)..."
sleep 5

# ── test_plan_panel_visible ────────────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_plan_panel_visible ──"
log "Checking for orchestration plan panel in header..."

PLAN_FOUND=0
ELAPSED=0
while [ "$ELAPSED" -lt "$TEST_TIMEOUT" ]; do
  capture
  # Save snapshot
  echo "$CAPTURE_TEXT" > "$CAPTURE_DIR/01-plan-panel.txt"
  # Check for plan panel markers
  if echo "$CAPTURE_TEXT" | grep -qE 'Orchestration Plan|Plan Panel|Plan:|┌.*Plan'; then
    PLAN_FOUND=1
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ "$PLAN_FOUND" -eq 1 ]; then
  pass "Plan panel visible in TUI"
else
  fail "Plan panel NOT found after ${TEST_TIMEOUT}s"
fi

# ── test_activity_feed_format ───────────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_activity_feed_format ──"
log "Checking for step icons (✓⠋○) and format..."

# Wait a bit more for activity to appear
wait_until_stable 3 20 || true
capture
echo "$CAPTURE_TEXT" > "$CAPTURE_DIR/02-activity-feed.txt"

ICONS_FOUND=0
# Check for any of the expected icons
if echo "$CAPTURE_TEXT" | grep -qE '[✓✔]'; then
  ICONS_FOUND=$((ICONS_FOUND + 1))
fi
if echo "$CAPTURE_TEXT" | grep -qE '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]'; then
  ICONS_FOUND=$((ICONS_FOUND + 1))
fi
if echo "$CAPTURE_TEXT" | grep -qE '[○●]'; then
  ICONS_FOUND=$((ICONS_FOUND + 1))
fi

if [ "$ICONS_FOUND" -ge 2 ]; then
  pass "Activity feed icons found (✓⠋○ present)"
elif [ "$ICONS_FOUND" -ge 1 ]; then
  pass "Activity feed icons found (partial: ${ICONS_FOUND}/3 types)"
else
  fail "No activity feed icons (✓⠋○) found"
fi

# ── test_specialist_name_in_header ─────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_specialist_name_in_header ──"
log "Checking for specialist names in tool blocks..."

# Wait for specialist activity
wait_for_text '(researcher|coder|scout|reviewer|writer|orchestrator|specialist)' "$TEST_TIMEOUT" || true
capture
echo "$CAPTURE_TEXT" > "$CAPTURE_DIR/03-specialist-blocks.txt"

SPECIALIST_FOUND=0
SPECIALIST_NAME=""
for name in researcher coder scout reviewer writer orchestrator; do
  if echo "$CAPTURE_TEXT" | grep -qi "$name"; then
    SPECIALIST_FOUND=1
    SPECIALIST_NAME="$name"
    break
  fi
done

if [ "$SPECIALIST_FOUND" -eq 1 ]; then
  pass "Specialist name found: $SPECIALIST_NAME"
else
  # Wait longer and retry
  sleep 10
  capture
  echo "$CAPTURE_TEXT" > "$CAPTURE_DIR/03-specialist-blocks-retry.txt"
  for name in researcher coder scout reviewer writer orchestrator; do
    if echo "$CAPTURE_TEXT" | grep -qi "$name"; then
      SPECIALIST_FOUND=1
      SPECIALIST_NAME="$name"
      break
    fi
  done
  if [ "$SPECIALIST_FOUND" -eq 1 ]; then
    pass "Specialist name found (retry): $SPECIALIST_NAME"
  else
    fail "No specialist names found in TUI"
  fi
fi

# ── Wait for completion ────────────────────────────────────────────────────
log ""
log "Waiting for orchestrator to finish..."
wait_until_stable 8 "$TEST_TIMEOUT" || true
capture
echo "$CAPTURE_TEXT" > "$CAPTURE_DIR/04-final-state.txt"

# ── test_plan_panel_not_collapsed ──────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_plan_panel_not_collapsed ──"
log "Verifying plan panel persists after completion..."

if echo "$CAPTURE_TEXT" | grep -qE 'Orchestration Plan|Plan Panel|Plan:|┌.*Plan'; then
  pass "Plan panel persists after completion"
else
  fail "Plan panel disappeared after completion"
fi

# ── test_no_crash_log (final) ──────────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_no_crash_log (final) ──"
log "Checking no TUI crash logs appeared during the run..."

CRASH_LOGS=$(find /tmp -maxdepth 3 \( -name "*.crash" -o -name "crash*" -o -name "*panic*" \) -newer "$CAPTURE_DIR/00-startup.txt" 2>/dev/null | head -5 || true)
if [ -n "$CRASH_LOGS" ]; then
  fail "Crash/panic logs found during run: $CRASH_LOGS"
else
  pass "No crash logs during the run"
fi

# ── Verify no error patterns in write log ──────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_no_tui_errors ──"
log "Checking PI_TUI_WRITE_LOG for actual crash/exception patterns..."

if [ -f "$PI_TUI_WRITE_LOG" ] && [ -s "$PI_TUI_WRITE_LOG" ]; then
  # Look for actual crash/exception/fatal/panic (not ANSI-rendered prompt noise)
  REAL_ERRORS=$(grep -ciE '(\bexception\b|\btraceback\b|\bfatal\b|\bpanic\b|\bSyntaxError\b|\bTypeError\b|\bReferenceError\b|\bRangeError\b|Uncaught\s+\w+Error|Cannot\s+read\s+property|cannot\s+find\s+module)' "$PI_TUI_WRITE_LOG" 2>/dev/null || true)
  REAL_ERRORS=${REAL_ERRORS:-0}
  if [ "$REAL_ERRORS" -gt 0 ]; then
    fail "Found ${REAL_ERRORS} crash/exception pattern(s) in write log"
  else
    pass "No crash/exception patterns in write log"
  fi
else
  pass "Write log not present or empty (acceptable)"
fi

# ── test_capture_dir_has_snapshots ─────────────────────────────────────────
TOTAL_TESTS=$((TOTAL_TESTS + 1))
log ""
log "── test_capture_dir_has_snapshots ──"
log "Verifying capture snapshots were saved..."

SNAP_COUNT=$(find "$CAPTURE_DIR" -name "*.txt" 2>/dev/null | wc -l | tr -d ' ')
if [ "$SNAP_COUNT" -ge 3 ]; then
  pass "Captured ${SNAP_COUNT} snapshots to $CAPTURE_DIR"
else
  fail "Only ${SNAP_COUNT} snapshot(s) found (expected ≥3)"
fi

# ════════════════════════════════════════════════════════════════════════════
# Done — exit handled by trap
# ════════════════════════════════════════════════════════════════════════════
