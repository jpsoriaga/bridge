# CLAUDE.md

Bridge lets the ChatGPT web chat edit a local project. A Chrome MV3 extension on chatgpt.com parses `@@FILE` blocks and shows diff cards. An Electron desktop app writes the files inside a sandboxed project root, connected over loopback. Personal project.

**Before any task, read PLAN.md, CHECKLIST.md and DESIGN.md (and SECURITY.md for anything touching a control). When you finish one, tick it in CHECKLIST.md.** Work only on the current phase.

## Stack

pnpm workspaces · TypeScript (strict) · Electron + electron-vite + React · Chrome MV3 via CRXJS + Vite + React · Vitest · ESLint 10 (flat) + Prettier · Geist / Geist Mono

## Layout

- `apps/desktop`: `src/main` (Node, the only code that touches disk or spawns), `src/preload` (`window.bridge`), `src/renderer` (React)
- `apps/extension`: `manifest.config.ts`, `src/content` (chatgpt.com), `src/background` (service worker), `src/sidepanel` (React)
- `packages/shared`: `@bridge/shared` TS source (types, chat parser and prompts, diff helper, logo geometry, `tokens.css` + `styles.css`). No build step
- `archive/prototype`: old prototype, reference only. Not built or linted. Don't import from it

## Commands

```bash
pnpm dev          # desktop + extension watch
pnpm build        # both apps
pnpm lint         # eslint .
pnpm typecheck    # tsc in every package
pnpm test         # vitest
pnpm format       # prettier --write .
pnpm version:set X.Y.Z            # one version: root, desktop, extension, shared
pnpm package:mac                  # (or :win, :linux) installers in apps/desktop/dist
pnpm build:extension:release      # store zip + Load unpacked zip in release/
```

Before saying a task is done, run format:check, lint, typecheck, build, `pnpm test:coverage` (thresholds in vitest.config.ts) and, for anything the app or extension does, the e2e scripts.
If `pnpm dev` fails with `electron.app` undefined, the shell has `ELECTRON_RUN_AS_NODE=1`. Use `env -u ELECTRON_RUN_AS_NODE pnpm dev`.

## Conventions

- Strict TS. No `any`; if one is truly unavoidable, add a comment saying why.
- Types and protocol shared by more than one app live in `@bridge/shared`. App-only types stay in the app.
- Match the surrounding style. Prettier decides formatting (single quotes, no trailing commas, width 100).
- UI uses tokens from `@bridge/shared/styles.css` only. No raw hex in components. Follow DESIGN.md.
- No new dependency without a clear need. Remove deps you stop using.

## Release rules

- One version everywhere: change it only with `pnpm version:set`; `version:check` (and the release workflow) fail otherwise. `MAJOR.MINOR.PATCH`, or `MAJOR.MINOR.PATCH-beta.N` for a beta (a pre-release, never Latest, no store zip; RELEASE.md "Beta release").
- Releases come from a `v*` tag through `.github/workflows/release.yml`, which leaves a **draft**; never publish from a script. Every release needs a `CHANGELOG.md` section ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)). RELEASE.md has the steps.
- Signing secrets go only in the `env:` of their platform's packaging step. Never in `ci.yml`, never `secrets: inherit`, never echoed. A partial set must fail (`scripts/package.mjs`).
- Packaging must keep passing `check:package` (fuses, asar contents) and the smoke test. A new runtime dependency goes in `dependencies` only if main `require()`s it; everything bundled by Vite (React, `@bridge/shared`) is a devDependency.
- `/health`, close code 4009 and its `protocol N` reason never change shape; bump `PROTOCOL_VERSION` for any incompatible message change, and both UIs then say which side to update.
- The store zip has no manifest `key`. `STORE_EXTENSION_ID` (shared) is the only place the store ID goes.
- Keep Actions pinned to commit SHAs. Store listing copy (`store/`) follows rule 6 below.

## Security rules (never break these)

1. The local server binds **127.0.0.1 only**, checks `Host` and `Origin`, and requires the pairing key's HMAC proofs. Pairing keeps a key only after the user confirmed the fingerprint in the app and the extension. Keep its limits (frame size, 2 connections, HTTP timeout, per-operation rates).
2. **Path sandbox** on every chat-supplied path: no absolute paths, no `..`, no symlinks that resolve outside the root, nothing under `.git`, no `.env*` files, no files with more than one hard link. Re-check the target folder's real path right before every commit (rename, link, remove).
3. Commands use **`spawn` with `shell: false`** and an **allowlist** the user sets in the app. Entries match **exactly**; only a trailing `*` allows extra arguments. Options in `DENIED_FLAGS` (shared `commands.ts`) are refused even under `*`; extend that one table, never bypass it. Never build a shell string. The one exception is Windows: `.cmd`/`.bat` shims can't be spawned without a shell, so `CommandRunner` uses `cross-spawn` there (only when `process.platform === 'win32'`), which escapes every argument for `cmd.exe`, and Bridge refuses cmd metacharacters in arguments to batch files. See PLAN.md, "Phase 5 decisions".
4. Electron: `app.enableSandbox()`, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP (no `unsafe-*`), permissions and navigation refused for every web contents, fuses set at packaging. Preload exposes only narrow, typed methods; every IPC channel has a zod schema in `main/ipc.ts` and goes through `handle()`.
5. **No telemetry**, analytics or non-loopback network calls. The one exception: the app's notify-only update check (`main/updates.ts`) asks GitHub Releases, only on the user's click or their opt-in "check at launch", never downloads or installs, and is off in unsigned macOS builds. Don't widen it. The extension never leaves loopback.
6. **No Codex or OpenAI branding** in names, UI, icons or copy. Say "the chat".
7. Extension permissions stay minimal: chatgpt.com only, no `<all_urls>`, empty `externally_connectable`. Every `chrome.runtime` listener checks the sender and parses with zod.
8. **Redaction:** everything Bridge puts into the chat (command output, file contents) goes through `redactSecrets`, via the `prompts.ts` builders. Never insert raw content around them.
9. `chrome.storage.local` holds paths, hashes, counts and states only: never file contents, output or keys.
