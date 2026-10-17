# Checklist

Tick items as they land. One line each, concrete enough to verify. See PLAN.md for the why.

## Phase 1: Monorepo setup

- [x] `pnpm-workspace.yaml` covers `apps/*` and `packages/*`
- [x] Root `package.json`: private, `type: module`, pinned `packageManager`, `engines.node >=24`
- [x] Root scripts: `dev`, `build`, `lint`, `format`, `format:check`, `typecheck`, `test`
- [x] `tsconfig.base.json` (strict, `moduleResolution: bundler`) extended by every package
- [x] `eslint.config.js` (ESLint 10, typescript-eslint, react-hooks), `.prettierrc`, `.prettierignore`, `.editorconfig`, `.nvmrc`
- [x] `.gitignore` covers node_modules, dist, out, release, `.env*`
- [x] CI runs format:check, lint, typecheck, test and build on mac, linux and windows
- [x] `@bridge/shared`: `exports` for TS source, `styles.css` and `logo.svg`. No build step
- [x] `FileEdit` and `Mode` types, plus `MODES`, `MODE_LABELS` and `MODE_DESCRIPTIONS`
- [x] `parseFileBlocks(text): FileEdit[]` for the `@@FILE path@@` + fence format
- [x] Parser tests: single, multiple, none, unterminated, spaces in path, long fence, CRLF, missing fence
- [x] Desktop: electron-vite + React, `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`
- [x] Desktop: strict CSP meta (dev-only `'unsafe-inline'` styles via plugin). Navigation and window.open denied. Permissions refused
- [x] Desktop: preload exposes only typed `window.bridge.version`
- [x] Desktop: renderer renders the mode switch from `@bridge/shared`
- [x] Extension: `manifest.config.ts`, content script on `https://chatgpt.com/*` only, permissions `storage` and `sidePanel`
- [x] Extension: content script logs `[Bridge] content script loaded` and calls `parseFileBlocks('')`
- [x] Extension: background worker opens the side panel on action click. React side panel stub
- [x] Design tokens (light and dark), Geist and Geist Mono, base `.btn`, `.segmented`, `.status` and `.dot` classes
- [x] Logo: SVG source, `LOGO_MARK` geometry, extension PNG icons, 1024px desktop icon
- [x] Docs: CLAUDE.md, PLAN.md, CHECKLIST.md, README.md, DESIGN.md
- [x] Root `vitest.config.ts` with `projects` for shared, desktop and extension. `pnpm test` runs all
- [x] Desktop: `createWindowOptions()` tested for `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity`
- [x] Desktop: test that the production CSP has no `unsafe-inline` or `unsafe-eval`
- [x] Extension: manifest tests (permissions exactly `storage` + `sidePanel`, chatgpt.com only, no `<all_urls>` or `host_permissions`)
- [ ] Delete `archive/prototype/` once Phases 2–7 no longer need it for reference

## Phase 2: Local server and pairing

- [x] Electron upgraded 34 → 44 (and electron-vite 2 → 6) before Phase 2 work, committed separately
- [x] Protocol envelope `{v, id, type, payload}` plus message types in `@bridge/shared`
- [x] zod schemas for every message (`auth`, `auth_ok`, `auth_error`, `ping`, `pong`, `status`, `error`), with tests for valid and invalid payloads
- [x] Shared `ConnectionStatus` type: `app-not-running`, `not-paired`, `connecting`, `connected`, `error`
- [x] Fastify + `@fastify/websocket` server in main, bound to `127.0.0.1`, default port 47821 with fallback to 47830. Active port saved in settings
- [x] Reject any request whose `Host` isn't `127.0.0.1:<port>`
- [x] Reject `/pair`, `/unpair` and `/ws` unless `Origin` is `chrome-extension://<id>` from `ALLOWED_EXTENSION_IDS`. Manifest `key` pins the dev ID
- [x] `GET /health` returns only `{ name, version }`. No CORS headers. Logger off
- [x] Body size cap, WebSocket frame cap and per-connection rate limit
- [x] Pairing: 6-digit code, 2-minute expiry, single use, exchanged for a 32-byte token. Only the SHA-256 is stored, encrypted with `safeStorage` when available
- [x] `/pair` locks for 60s after 5 wrong codes. Codes and tokens compared in constant time
- [x] Unpair from the desktop or the extension revokes the token. The open socket closes. Pairing again replaces the old token
- [x] Background worker connects, authenticates in the first message within 5s, pings every 20s, and reconnects with backoff (1s → 30s)
- [x] Verify whether loopback needs `host_permissions`: HTTP does, WebSocket doesn't. Added `http://127.0.0.1/*` and documented it in PLAN.md
- [x] Side panel: pairing-code entry, token in `chrome.storage.local`, Unpair, "Open the Bridge app" hint
- [x] Status pill live in desktop and side panel
- [x] Desktop: Pair extension with code and countdown, paired state, Unpair, server port under Settings
- [x] Content script asks the worker for status and logs it. Nothing injected into chatgpt.com
- [x] Preload API grows by typed methods only (`getStatus`, `onStatus`, `startPairing`, `unpair`), each on its own channel with a sender check
- [x] Tests: wrong Host, wrong Origin, missing or invalid token, late auth, expired or reused code, rate limit, oversized messages, happy path, unpair revokes
- [x] Tests: reconnect backoff timing (fake timers), connection manager, manifest permissions and key → ID

## Phase 3: Reading the chat

- [ ] `MutationObserver` on the conversation container. Selectors isolated in one module
- [ ] Detect end of streaming before parsing a message
- [ ] Parse each assistant message once, keyed by message id
- [ ] Shadow-root mount point under a message for injected cards
- [ ] Read-only diff card (pending style) for each `FileEdit`
- [ ] Send parsed edits to the desktop. They show up in the activity log
- [ ] Handle page navigation between conversations (SPA route changes)

## Phase 4: Applying edits safely

- [ ] Project picker (native dialog) in desktop. Root persisted
- [ ] Path sandbox module with unit tests: absolute, drive letter, NUL, `..`, symlink escape, `.git`, `.env*`
- [ ] File size cap
- [ ] Compute diff against the file on disk. Show `+N −M` and diff rows on the card
- [ ] Apply: atomic write (temp file + rename). Create parent dirs inside the root only
- [ ] Reject: mark the card rejected. Nothing is written
- [ ] Undo history per edit (previous content or "did not exist")
- [ ] Card error state with a human-readable reason
- [ ] Activity rows: applied, waiting for review, blocked

## Phase 5: Modes and undo

- [ ] Mode persisted in desktop and synced to the side panel
- [ ] Auto-apply writes on end-of-message. The card shows Applied + Undo
- [ ] Undo restores previous content or deletes a newly created file
- [ ] Undo all edits from one message
- [ ] Files-in-context tree in the side panel with `new` tags

## Phase 6: Sending context

- [ ] "Start session" inserts a prompt that teaches the `@@FILE` format
- [ ] "Send files" picker (respects `.gitignore`, size cap) fills the composer
- [ ] Insert text into the composer without auto-sending
- [ ] Activity row: "Sent N files to chat"

## Phase 7: Commands and full auto

- [ ] Allowlist of exact argv prefixes in one module, with tests
- [ ] `spawn` with `shell: false`, cwd = root, timeout, output cap, scrubbed env
- [ ] Command card with "Run & send output". Output is pasted back to the chat
- [ ] Full-auto loop: apply, run, send output, wait for the reply
- [ ] Step limit (default 10) and "Step N of M" counter
- [ ] Stop button ends the loop immediately in both UIs

## Phase 8: Hardening and release

- [ ] Security review against PLAN.md "Security model"
- [x] Upgrade Electron to a supported major (34 → 44, done at the start of Phase 2)
- [ ] E2E smoke test: the parser runs in the content script, apply and undo work against a temp project
- [ ] electron-builder packages for macOS (dmg, zip) and Windows (nsis)
- [ ] Extension zip for "Load unpacked" or store upload
- [ ] README and docs pass. Remove placeholder copy
