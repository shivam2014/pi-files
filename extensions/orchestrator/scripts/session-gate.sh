#!/usr/bin/env bash
# session-gate.sh — End-of-session regression gate
# Runs vitest, optional tui-smoke, and uncommitted-changes check.
# Exit 0 if all pass, 1 if any fail.

set -euo pipefail

ORCH_DIR="/Users/shivam94/.pi/agent/extensions/orchestrator"
SMOKE_SCRIPT="$HOME/.pi/tui-smoke.sh"

PASS=0
FAIL=0
RESULTS=()

# --- helpers ---
pass() { PASS=$((PASS + 1)); RESULTS+=("  ✅ $1"); }
fail() { FAIL=$((FAIL + 1)); RESULTS+=("  ❌ $1 — $2"); }

echo "═══ Session Gate ═══"
echo ""

# ── 1. Vitest ──────────────────────────────────────────────
echo "▸ Running vitest..."
if (cd "$ORCH_DIR" && npx vitest run 2>&1); then
  pass "vitest"
else
  fail "vitest" "tests failed"
fi
echo ""

# ── 2. TUI smoke (optional) ───────────────────────────────
echo "▸ Checking tui-smoke..."
if [[ -x "$SMOKE_SCRIPT" ]]; then
  if bash "$SMOKE_SCRIPT" 2>&1; then
    pass "tui-smoke"
  else
    fail "tui-smoke" "smoke test failed"
  fi
elif [[ -f "$SMOKE_SCRIPT" ]]; then
  if bash "$SMOKE_SCRIPT" 2>&1; then
    pass "tui-smoke"
  else
    fail "tui-smoke" "smoke test failed"
  fi
else
  pass "tui-smoke (skipped — not found)"
fi
echo ""

# ── 3. Uncommitted changes ─────────────────────────────────
echo "▸ Checking git status..."
if git -C "$ORCH_DIR" diff --quiet HEAD 2>/dev/null && \
   git -C "$ORCH_DIR" diff --cached --quiet 2>/dev/null; then
  pass "git-clean"
else
  fail "git-clean" "uncommitted changes in $ORCH_DIR"
fi
echo ""

# ── Summary ─────────────────────────────────────────────────
echo "═══ Results ═══"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo ""
echo "Total: $((PASS + FAIL)) checks — $PASS passed, $FAIL failed"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "Gate: FAILED"
  exit 1
else
  echo "Gate: PASSED"
  exit 0
fi
