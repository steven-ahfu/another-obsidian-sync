# AGENTS.md

This file provides guidance to Claude Code when working with code in this repository.

## Active Branch

Always work on `feature/protondrive`. The `main` branch is frozen.

This checkout (Windows) sits directly inside `another-obsidian-sync/`; there are no sibling reference forks here. (The companion WSL checkout at `\\wsl.localhost\Ubuntu\home\steven\Projects\obsidian-sync\` keeps `remotely-save/` next to it as read-only upstream reference.)

## Commands

Two parallel build pipelines exist. **Webpack is the canonical production pipeline** (`build` / `dev`); esbuild (`build2` / `dev2`) is kept as a fast secondary check.

```bash
pnpm run dev          # webpack --mode development --watch
pnpm run build        # webpack --mode production → main.js
pnpm run build:vault  # webpack production + scripts/deploy-vault.mjs (copies main.js, manifest.json, styles.css to a vault)
pnpm run deploy:vault # just the deploy step (no rebuild)
pnpm run dev2         # esbuild watch (fast iteration, no type-check)
pnpm run build2       # tsc --noEmit type-check + esbuild production
pnpm test             # mocha + ts-node, runs tests/**/*.ts
pnpm run format       # prettier --write
pnpm run clean        # remove main.js
```

Run a single test file:

```bash
pnpm exec cross-env TS_NODE_COMPILER_OPTIONS='{"module":"commonjs"}' mocha -r ts-node/register tests/syncV3.test.ts
```

Use mocha `--grep "<pattern>"` to filter by test name.

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
