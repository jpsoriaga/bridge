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
- [ ] Delete `archive/prototype/` once Phases 2–6 no longer need it for reference

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

### Phase 2 follow-ups

- [x] Mutual challenge-response (`hello` → `challenge` → `auth`), HMAC over the token hash bound to role, purpose and port. Protocol v2. The token is never sent after `/pair`
- [x] Extension stores only `tokenHash` (migrates a Phase 2 `token` once). Wrong server proof closes and that port isn't retried
- [x] `/unpair` uses the same proof flow (`/unpair/challenge` then `/unpair`), no bearer token
- [x] Constant-time compares on both sides. Client nonces single use (10 min ledger); server nonces single use
- [x] Port pinning: last verified port first, scan 47821–47830 only if it fails, re-pin to the verified server
- [x] `alarms` permission: 1-minute `reconnect` alarm while paired and disconnected, cleared once connected. Manifest test updated
- [x] Playwright scripts saved in `e2e/` with a README (manual, not in CI)
- [x] Tests: wrong server proof rejected, replayed nonce (hello, unpair, auth proof, server challenge) rejected, port pinning, alarm set/clear

## Phase 3: Project and files

- [x] **Open folder…** with `dialog.showOpenDialog` in main. Renderer never sends a path (recents open by index)
- [x] Refuse a file, the disk root, the home folder, and folders overlapping userData
- [x] Current project and up to 5 recents in `settings.json`. Last project reopens on launch if it still exists
- [x] Project name and path in the desktop top bar and the side panel. `status` carries the project and is pushed on every switch
- [x] Every file operation returns `no-project` when no folder is open
- [x] Sandbox module: relative POSIX only, NFC, ≤1024 chars, no absolute/drive/UNC, backslash, NUL/control chars, empty, `.`/`..` segments, `:` or trailing dot/space
- [x] Component-by-component `lstat`/`realpath` walk: symlinks must stay inside the real root and off the denylist. New files resolve through the nearest real parent. Dangling links refused
- [x] `DEFAULT_DENYLIST` (`.git/`, `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `node_modules/`), case-insensitive, plus user patterns in Settings that can't undo a default
- [x] Typed `FileErrorCode` for every refusal, logged in the activity list. No absolute path ever goes back to the extension
- [x] zod schemas in shared for `tree`, `read`, `write`, `undo` and `response` (reply carries the request `id`). WS frame cap raised to 8 MiB
- [x] `tree`: `.gitignore` (nested too), denylist, skips `dist`/`out`/`build`/`.next`, `node_modules` collapsed, 5,000 entries and depth 12 with `truncated`
- [x] `read`: text only (NUL in first 8 KB), ≤1 MB, returns `{ content, hash, eol }`
- [x] `write`: `baseHash` required to modify (`conflict` when stale or gone), absent to create (`exists`), atomic temp + rename / link, parents created inside the sandbox, ≤1 MB, EOL kept
- [x] Backups and op log in `userData/backups/<projectId>/`, never in the project. Backup before every write
- [x] Undo restores a modify or removes a create; `conflict` after an external edit unless confirmed in the app (native dialog). `undo { opId }` message from the extension, never forced
- [x] Prune after 7 days or 500 ops per project
- [x] Desktop UI: Open folder, recents, project header, activity list (time, path, kind, Undo, blocked entries), Undo last, protected-file patterns
- [x] Side panel: project name and path. Dev-only file tester (tree, read, write, undo) behind `import.meta.env.DEV`, with the worker path gated the same way
- [x] Tests: 49 sandbox attack cases plus valid cases and real symlinks; write conflict/exists/atomic/EOL; undo modify/create/conflict/prune; tree caps and ignores; service; socket requests. Real temp folders, no fs mocks
- [x] `e2e/project.cjs`: tree, read, write, undo and refusals against the real app and a dev build of the extension

## Phase 4: Chat integration (Manual mode)

- [x] Old Phase 6 ("Sending context") folded in. Phases renumbered in PLAN.md: 5 Modes, 6 Commands, 7 Hardening
- [x] `buildSessionPrompt({ projectName, tree })`: FILE/READ/CONTEXT rules, whole files only, tree outline capped near 1,500 entries with folders summarised
- [x] `formatContextBlock` / `buildContextMessage` with `pickFence` (longer than any backtick run in the file)
- [x] `parseChat`: plain and inline-code markers, list bullets, `__init__.py`, `@@READ` (one or several per line), skips `@@CONTEXT` and unmarked fences, stops at an unterminated fence, `suspectedPartial`, `fence` index per edit
- [x] `diffFile` on jsdiff: new / modified / unchanged, CRLF-insensitive, hunks with 3 lines of context, 1s timeout fallback
- [x] `selectors.ts` holds every chatgpt.com selector with fallbacks; `checkLayout` drives "Bridge can't read this page layout" in the side panel
- [x] `messageToText` DOM → text adapter (assistant messages only; `code.textContent`, not the code block header)
- [x] Fixtures in `apps/extension/fixtures/chatgpt/`: single edit, multiple edits, streaming, code block header, user message
- [x] One debounced `MutationObserver`; parse only after the streaming marker goes and the action buttons appear; re-check on regenerate/edit; re-attach when `<main>` is replaced
- [x] Block key `conversationId:messageId:blockIndex:contentHash`; cards re-inserted idempotently after re-renders
- [x] Conversation id from `/c/<id>`; sessions bind when a new chat gets its id; client-side navigation followed by polling the URL
- [x] Diff card in a closed shadow root after its code block, text-only rendering, badges (`new`, `modified`, `unchanged`, `conflict`, `blocked`, `partial?`), `+N −M`, collapsible diff capped at 400 rows with "Show all"
- [x] Apply with `baseHash`; `conflict` re-reads and shows the new diff with an "updated since" note; Reject; Undo by `opId`; partial needs a second click
- [x] Apply all for 2+ applicable files, in order, stops at the first error
- [x] Card state in `chrome.storage.local` by block key (worker-owned), survives reload, pruned after 30 days
- [x] READ card: requested paths with sizes or "blocked · reason", character count, **Send these files** into the composer (no submit)
- [x] Composer insert: synthetic paste (`DataTransfer` text/plain), `execCommand('insertText')` fallback, never sends; warn above 30k characters
- [x] Side panel: Start session (count shown first), "Session active" with short conversation id, applied/pending counts, files sent, End session (cards disabled)
- [x] Side panel: Send files tree with checkboxes, filter, budget meter, max 50 files
- [x] Worker: zod-validated messages; content-script requests only from frame 0 of `https://chatgpt.com` tabs, panel requests only from extension pages; file requests need an active session
- [x] `write` carries `source: 'chat'`; desktop Activity shows "· via chat"
- [x] Fonts from the extension via `FontFace`, system font fallback if blocked
- [x] Tests: parser, prompts and fence picking, diff, adapter on fixtures (happy-dom), cards and Apply all, composer, card store and keys, sessions, sender checks
- [x] `e2e/chat.cjs`: stand-in chatgpt.com from the fixtures, real app and extension build: start session, apply, undo, Apply all, READ send, conflict, reload, regenerate, end session
- [ ] Manual run on the real chatgpt.com (README "Use it in the chat"); confirm the live page's CSP allows the extension fonts

## Phase 5: Modes and undo

- [ ] Mode persisted in desktop and synced to the side panel
- [ ] Auto-apply writes on end-of-message. The card shows Applied + Undo
- [ ] Undo all edits from one message
- [ ] Delete and rename operations (`@@DELETE path@@`), backed up like writes
- [ ] Files-in-context tree in the side panel with `new` tags

## Phase 6: Commands and full auto

- [ ] Allowlist of exact argv prefixes in one module, with tests
- [ ] `spawn` with `shell: false`, cwd = root, timeout, output cap, scrubbed env
- [ ] Command card with "Run & send output". Output is pasted back to the chat
- [ ] Full-auto loop: apply, run, send output, wait for the reply
- [ ] Step limit (default 10) and "Step N of M" counter
- [ ] Stop button ends the loop immediately in both UIs

## Phase 7: Hardening and release

- [ ] Security review against PLAN.md "Security model"
- [x] Upgrade Electron to a supported major (34 → 44, done at the start of Phase 2)
- [ ] E2E smoke test: the parser runs in the content script, apply and undo work against a temp project
- [ ] Keep the pairing key out of content-script reach (`chrome.storage.local` access level, or move it)
- [ ] electron-builder packages for macOS (dmg, zip) and Windows (nsis)
- [ ] Extension zip for "Load unpacked" or store upload
- [ ] README and docs pass. Remove placeholder copy
