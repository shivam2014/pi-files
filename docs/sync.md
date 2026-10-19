# Sync and restore

Two directions, both explicit.

## Live to canon

```bash
bash ~/.pi/sync.sh                # extensions + skills + root scripts
bash ~/.pi/sync.sh --check        # dry run; exit 1 when live has changes not in canon
bash ~/.pi/sync.sh --extensions   # only ~/.pi/agent/extensions -> extensions/
bash ~/.pi/sync.sh --skills       # only ~/.pi/agent/skills     -> agent/skills/
bash ~/.pi/sync.sh --scripts      # only ~/.pi/*.sh             -> repo root
```

Each tree prints its own changed-file count, so a skill change never hides inside an extension sync. The sync never uses `--delete`, so a file removed from live persists in canon until someone removes it deliberately.

The drift report at the end lists canon-only files a `--delete` sync would remove. Intentional entries (docs, the archive, `.gitignore`) are filtered out so the report stays readable.

## Canon to live

```bash
bash ~/.pi/restore.sh --check   # back up live, then show the canon -> live diff
bash ~/.pi/restore.sh --yes     # restore without a prompt
bash ~/.pi/restore.sh           # back up, then ask
```

Restore is safe by construction:

1. Backs up the live tree first to `~/.pi/restore-backups/<timestamp>/`.
2. Never deletes live files.
3. Keeps `node_modules` and lockfiles in place.
4. Excludes `node_modules`, lockfiles, `tsconfig.tsbuildinfo`, `diagnostics`, `.DS_Store`, `.gitignore`, and READMEs (canon-only docs).
5. Aborts if the canonical tree is missing.

After a restore, the extension still needs its dependencies:

```bash
cd ~/.pi/agent/extensions/orchestrator
npm install
npm test
```

## Guards

- **Pre-push hook** (`.githooks/pre-push`, enabled via `git config core.hooksPath .githooks`): runs `~/.pi/sync.sh --check` and blocks a push when canon is behind live.
- **CI** (`.github/workflows/verify.yml` -> `scripts/verify-repo.sh`): rejects tracked `node_modules`, lockfiles, `*.tsbuildinfo`, `.DS_Store`, and diagnostics dumps; validates every `package.json`; requires `SKILL.md` in every skill directory.

## Notes

- Old incident dumps from `extensions/orchestrator/diagnostics/` were moved out of the repo to `~/.pi/diagnostics-archive-20261019/` (1.1 MB). Canon no longer carries them; the path is gitignored.
- Lockfiles were untracked from canon. They are generated locally and are not part of the backup.
