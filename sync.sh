#!/bin/bash
# Sync pi extensions, skills, and root scripts from the live location to the
# pi-files canon.
#
# Modes:
#   (default)      sync everything
#   --check        dry run; exit 1 when live has changes not in canon
#   --extensions   only ~/.pi/agent/extensions -> extensions/
#   --skills       only ~/.pi/agent/skills     -> agent/skills/
#   --scripts      only ~/.pi/*.sh             -> repo root
#   --help         this text
#
# Excludes node_modules, lockfiles, build artifacts, nested repos, and
# diagnostics so stale state never propagates into canon.
#
# The drift report at the end is informational: it lists canon-only files that a
# --delete sync would remove. Most are intentional (docs, the archive) and are
# filtered through CANON_ONLY_ALLOW so the report stays readable.

set -uo pipefail

MODE="sync"
SELECT="all"
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --extensions) SELECT="extensions" ;;
    --skills) SELECT="skills" ;;
    --scripts) SELECT="scripts" ;;
    --help | -h)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

SOURCE="$HOME/.pi/agent/extensions/"
TARGET="$HOME/pi-files/extensions/"
SKILL_SOURCE="$HOME/.pi/agent/skills/"
SKILL_TARGET="$HOME/pi-files/agent/skills/"

EXCLUDES=(
  --exclude='node_modules/'
  --exclude='.git/'
  --exclude='.pi/'
  --exclude='.claimed-by'
  --exclude='diagnostics/'
  --exclude='package-lock.json'
  --exclude='.package-lock.json'
  --exclude='tsconfig.tsbuildinfo'
  --exclude='.DS_Store'
)

CANON_ONLY_ALLOW='diagnostics/|README\.md$|\.README\.md$|\.gitignore$|/archive/'

ROOT_SCRIPTS=(
  "tui-smoke.sh"
  "sync.sh"
  "restore.sh"
  "claim.sh"
  "check-claim.sh"
  "release-claim.sh"
)

DRIFT=0
DRIFT_FILES=()

# Print the files rsync would change, one per line. `-l` preserves symlinks so
# they are compared instead of reported as "skipping non-regular file".
changed_files() {
  rsync -rln --out-format='%n' "${EXCLUDES[@]}" "$1" "$2" 2>/dev/null
}

sync_tree() {
  local label="$1" source="$2" target="$3"
  local changes count=0
  changes="$(changed_files "$source" "$target")"
  if [ -n "$changes" ]; then
    count="$(printf '%s\n' "$changes" | grep -c .)"
  fi

  if [ "$MODE" = "check" ]; then
    if [ "$count" -gt 0 ]; then
      printf '%s: %s change(s) not in canon\n' "$label" "$count"
      printf '%s\n' "$changes" | sed 's/^/  /' | head -20
      DRIFT=$((DRIFT + count))
      while IFS= read -r file; do DRIFT_FILES+=("$file"); done <<<"$changes"
    else
      printf '%s: in sync\n' "$label"
    fi
    return 0
  fi

  if [ "$count" -gt 0 ]; then
    printf '%s: syncing %s change(s)\n' "$label" "$count"
    rsync -a "${EXCLUDES[@]}" "$source" "$target"
  else
    printf '%s: in sync\n' "$label"
  fi
}

if [ "$SELECT" = "all" ] || [ "$SELECT" = "extensions" ]; then
  sync_tree "extensions" "$SOURCE" "$TARGET"
fi

if [ "$SELECT" = "all" ] || [ "$SELECT" = "skills" ]; then
  mkdir -p "$SKILL_TARGET"
  sync_tree "skills" "$SKILL_SOURCE" "$SKILL_TARGET"
fi

if [ "$SELECT" = "all" ] || [ "$SELECT" = "scripts" ]; then
  for file in "${ROOT_SCRIPTS[@]}"; do
    if [ ! -f "$HOME/.pi/$file" ]; then
      echo "scripts: missing live script ~/.pi/$file (skipped)"
      continue
    fi
    if [ "$MODE" = "check" ]; then
      if ! cmp -s "$HOME/.pi/$file" "$HOME/pi-files/$file"; then
        echo "scripts: $file differs"
        DRIFT=$((DRIFT + 1))
        DRIFT_FILES+=("$file")
      fi
    else
      rsync -a "$HOME/.pi/$file" "$HOME/pi-files/$file"
    fi
  done
fi

if [ "$MODE" = "check" ]; then
  if [ "$DRIFT" -gt 0 ]; then
    echo ""
    echo "DRIFT: $DRIFT live change(s) are not in canon. Run: bash ~/.pi/sync.sh"
    exit 1
  fi
  echo "canon is in sync with live"
  exit 0
fi

echo "✅ synced (excluded: node_modules, lockfiles, build artifacts, .git, .pi, diagnostics)"

echo ""
echo "— canon-only files (informational; a --delete sync would remove these) —"
rsync -avn --delete "${EXCLUDES[@]}" "$SOURCE" "$TARGET" 2>/dev/null |
  grep -E '^(deleting|\*deleting)' |
  grep -vE "$CANON_ONLY_ALLOW" |
  head -40 || true
echo "(intentional canon-only docs and archive are filtered out; no files were changed)"
