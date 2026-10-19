#!/bin/bash
# Restore the live pi extensions/skills from the canonical pi-files backup.
#
# Safe by default:
#   - backs up the live tree first (timestamped, under ~/.pi/restore-backups)
#   - never deletes live files (no --delete)
#   - keeps node_modules and lockfiles in place
#
# Modes:
#   bash ~/.pi/restore.sh --check   backup + show the canon -> live diff, change nothing else
#   bash ~/.pi/restore.sh --yes     restore without the confirmation prompt
#   bash ~/.pi/restore.sh           backup, then ask before restoring
#
# Env overrides exist so the script can be tested against temp trees:
#   LIVE_EXT, CANON_EXT, LIVE_SKILLS, CANON_SKILLS, BACKUP_ROOT

set -euo pipefail

MODE="${1:-}"
LIVE_EXT="${LIVE_EXT:-$HOME/.pi/agent/extensions}"
CANON_EXT="${CANON_EXT:-$HOME/pi-files/extensions}"
LIVE_SKILLS="${LIVE_SKILLS:-$HOME/.pi/agent/skills}"
CANON_SKILLS="${CANON_SKILLS:-$HOME/pi-files/agent/skills}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.pi/restore-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/$STAMP"

EXCLUDES=(
  --exclude='node_modules/'
  --exclude='package-lock.json'
  --exclude='.package-lock.json'
  --exclude='tsconfig.tsbuildinfo'
  --exclude='.DS_Store'
  --exclude='diagnostics/'
)

if [ ! -d "$CANON_EXT" ]; then
  echo "canonical tree not found: $CANON_EXT" >&2
  echo "run: bash ~/.pi/sync.sh   (or git -C ~/pi-files pull)" >&2
  exit 1
fi

mkdir -p "$BACKUP"
echo "backing up live tree to $BACKUP"
rsync -a --exclude='node_modules/' "$LIVE_EXT/" "$BACKUP/extensions/"
if [ -d "$LIVE_SKILLS" ]; then
  rsync -a --exclude='.DS_Store' "$LIVE_SKILLS/" "$BACKUP/skills/"
fi
echo "backup done"

if [ "$MODE" = "--check" ]; then
  echo "— canon -> live diff (dry run, nothing restored) —"
  rsync -avn "${EXCLUDES[@]}" "$CANON_EXT/" "$LIVE_EXT/"
  echo "(no files changed)"
  exit 0
fi

if [ "$MODE" != "--yes" ]; then
  read -r -p "Restore $CANON_EXT -> $LIVE_EXT? [y/N] " answer
  case "$answer" in
    y | Y) ;;
    *)
      echo "aborted"
      exit 1
      ;;
  esac
fi

rsync -a "${EXCLUDES[@]}" "$CANON_EXT/" "$LIVE_EXT/"
if [ -d "$CANON_SKILLS" ]; then
  rsync -a --exclude='.DS_Store' "$CANON_SKILLS/" "$LIVE_SKILLS/"
fi
echo "restored from $CANON_EXT"
echo "backup: $BACKUP"
echo "next: cd $LIVE_EXT/orchestrator && npm install && npm test"
