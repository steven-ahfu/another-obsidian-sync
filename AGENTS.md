# AGENTS.md

This file provides guidance to Claude Code when working with code in this repository.

## Working Directory

**`another-obsidian-sync/` is the only active development directory.** Always work there.

`remotely-save/` and any other directories are reference forks only — do not modify them.

```
obsidian-sync/
├── another-obsidian-sync/   ← ACTIVE — work here only
├── remotely-save/           ← reference only (upstream by fyears)
└── ...                      ← any other dirs are reference only
```

## Active Branch

Always work on `feature/protondrive`. The `main` branch is frozen.

```bash
cd another-obsidian-sync
git checkout feature/protondrive
```

## Commands

```bash
cd another-obsidian-sync

pnpm run dev       # esbuild watch (development)
pnpm run build     # esbuild production build → main.js
pnpm run build2    # tsc check + esbuild production build
pnpm test          # mocha tests
pnpm run format    # prettier --write
pnpm run clean     # remove main.js
```

## Architecture

`another-obsidian-sync` is a fork that merged the best ideas from `remotely-save` (FakeFs abstraction, sync v3 algorithm, conflict resolution) and `remotely-sync` (AES-GCM encryption), with original work on top.

```
RemotelySavePlugin (main.ts)
  └─ syncRun()
       ├─ FakeFsLocal          ← Obsidian Vault API
       ├─ FakeFsEncrypt        ← AES-GCM decorator (rclone or openssl cipher)
       │    └─ FakeFsS3 / FakeFsDropbox / FakeFsWebdav / FakeFsOnedrive / FakeFsProtonDrive / ...
       └─ syncV3.ts            ← conflict-resolution sync algorithm (ported from remotely-save Pro, paywall removed)
```

Key files:
- `src/fsAll.ts` — abstract FakeFs interface
- `src/fsGetter.ts` — backend factory
- `src/fsEncrypt.ts` — encryption decorator
- `src/syncV3.ts` — core sync algorithm
- `src/settings.ts` — Obsidian settings tab UI
- `src/main.ts` — plugin entry point, sync orchestration

## Completed Features (feature/protondrive)

1. **FakeFs architecture** — ported from remotely-save
2. **Sync v3** — conflict-resolution algorithm, paywall gating removed
3. **MinIO/S3** — OOM fix, `forcePathStyle` defaulted for MinIO
4. **Encryption** — AES-GCM decorator + rclone cipher, web worker
5. **Proton Drive** — sixth backend, E2E address key decryption

## Patterns

- **Local persistence:** `localforage` (IndexedDB) — sync history, plans, deletion tracking
- **Remote metadata:** small file on remote tracks deletions across devices
- **Settings:** `configPersist.ts` handles serialization + migration; `settings.ts` is the UI
- **OAuth2:** Dropbox and OneDrive use Obsidian URI protocol callbacks
- **Sync triggers:** manual, dry-run, auto-interval, init-once, sync-on-save
