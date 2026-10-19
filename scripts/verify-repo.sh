#!/usr/bin/env bash
# Repo hygiene checks for the pi-files canon. Runs in CI and locally.
set -uo pipefail

fail=0
tracked="$(git ls-files)"

check_pattern() {
  local pattern="$1" label="$2"
  if printf '%s\n' "$tracked" | grep -qE "$pattern"; then
    echo "FAIL: tracked $label"
    printf '%s\n' "$tracked" | grep -E "$pattern" | head -5
    fail=1
  fi
}

check_pattern 'node_modules/' 'node_modules'
check_pattern 'package-lock\.json' 'lockfiles'
check_pattern 'tsbuildinfo' 'build artifacts'
check_pattern '\.DS_Store' '.DS_Store'
check_pattern 'extensions/.*/diagnostics/' 'diagnostics dumps'

while IFS= read -r file; do
  [ -n "$file" ] || continue
  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" 2>/dev/null; then
    echo "FAIL: invalid JSON: $file"
    fail=1
  fi
done <<<"$(printf '%s\n' "$tracked" | grep -E '(^|/)package\.json$')"

for dir in agent/skills/*/; do
  [ -d "$dir" ] || continue
  if [ ! -f "$dir/SKILL.md" ]; then
    echo "FAIL: $dir missing SKILL.md"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "repo hygiene OK"
fi
exit "$fail"
