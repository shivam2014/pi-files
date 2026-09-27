#!/bin/bash
# Sync pi extensions from live location to pi-files repo
# Excludes node_modules, lockfiles, build artifacts, and nested repo/diagnostic dirs to prevent stale state propagation

SOURCE="$HOME/.pi/agent/extensions/"
TARGET="$HOME/pi-files/extensions/"

rsync -av \
  --exclude='node_modules/' \
  --exclude='.git/' \
  --exclude='.pi/' \
  --exclude='.claimed-by' \
  --exclude='diagnostics/' \
  --exclude='package-lock.json' \
  --exclude='.package-lock.json' \
  --exclude='tsconfig.tsbuildinfo' \
  --exclude='.DS_Store' \
  "$SOURCE" "$TARGET"

echo "✅ Extensions synced (excluded: node_modules, .git, .pi, diagnostics, lockfiles, build artifacts)"

# Also sync skills
SKILL_SOURCE="$HOME/.pi/agent/skills/"
SKILL_TARGET="$HOME/pi-files/agent/skills/"
mkdir -p "$SKILL_TARGET"
rsync -av --exclude='.DS_Store' "$SKILL_SOURCE" "$SKILL_TARGET"
echo "✅ Skills synced"

# ── Root-level scripts (~/.pi/*.sh) → pi-files root ──────────────────────────
# The directory rsyncs above only walk ~/.pi/agent/{extensions,skills}; scripts
# sitting directly in ~/.pi were never covered, so they drifted from canon
# (tui-smoke.sh was 51 lines ahead of canon and needed a manual cp).
# Exclusions from the tree syncs above (node_modules, lockfiles, build
# artifacts, .git, .pi, diagnostics) stay as-is; individual files need none.
ROOT_SCRIPTS=(
  "tui-smoke.sh"
  "sync.sh"
  "claim.sh"
  "check-claim.sh"
  "release-claim.sh"
)
for f in "${ROOT_SCRIPTS[@]}"; do
  if [ -f "$HOME/.pi/$f" ]; then
    rsync -av "$HOME/.pi/$f" "$HOME/pi-files/$f"
  else
    echo "⚠️  missing live script: ~/.pi/$f (skipped)"
  fi
done
echo "✅ Root scripts synced (${ROOT_SCRIPTS[*]})"

# ── Drift check (dry-run, non-destructive) ───────────────────────────────────
# This sync runs without --delete, so files removed from live persist in canon
# forever. This block reports what a `--delete` sync WOULD remove/add.
# It is informational only — no files are changed here.
#
# NOTE: listed deletions are canon-only files (documentation/config/tests kept
# intentionally) — informational, never to be applied blindly. The live tree is
# a strict subset of canon (13 out, 0 in, as of 2026-09-20).
echo ""
echo "— drift report (informational only) —"
rsync -avn --delete \
  --exclude='node_modules/' \
  --exclude='.git/' \
  --exclude='.pi/' \
  --exclude='.claimed-by' \
  --exclude='diagnostics/' \
  --exclude='package-lock.json' \
  --exclude='.package-lock.json' \
  --exclude='tsconfig.tsbuildinfo' \
  --exclude='.DS_Store' \
  "$SOURCE" "$TARGET" | grep -E '^(deleting|adding|>f|\*deleting)' | head -40
echo "(no files were changed)"
