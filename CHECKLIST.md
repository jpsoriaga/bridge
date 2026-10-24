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
- [ ] Manual run on the real chatgpt.com (README "Use it in the chat"); confirm the live page's CSP allows the extension fonts (cards, Apply/Undo and READ done in Phase 5's live run; fonts not checked)

### Phase 4 follow-ups

- [x] Pairing key moved from `chrome.storage.local` to the worker's IndexedDB; migrated once and deleted from storage. Test: the content script's import graph can't reach it
- [x] Card fonts on their own `web_accessible_resources` entry with `use_dynamic_url: true`; e2e checks Geist loads and the static URL is refused
- [x] READ card state (`pending` / `sent`) saved by block key like diff cards

## Phase 5: Modes, commands and Full auto

- [x] Phases renumbered in PLAN.md: old 5 (modes) and 6 (commands, full auto) merged into 5; 6 is app UI polish
- [x] Protocol v3: `write` carries `trigger` (+ `loopId`); `run`, `run_cancel`, `run_output`, `run_exit`, `loop_report`, `loop_stop`, `session_end`; `status` carries the config
- [x] Mode held by the app (`ModeState`), mirrored in the side panel and on the cards; Manual and Auto-apply persist, Full auto never does
- [x] Full auto behind a native confirm dialog (terms risk, model-written code, opt-in at own risk); resets on restart, End session, unpairing, project switch
- [x] Server rejects `auto` writes in Manual, `auto` writes to gated files, `auto` runs outside Full auto, and any command not allowlisted even on a click
- [x] Gated files in one list (`DEFAULT_GATED_FILES`) plus user patterns; limits documented in PLAN.md
- [x] Auto-apply on new replies: skips partial, conflict, blocked, gated, over 1 MB; "Auto-applied" + Undo; Undo all per message; toast and "auto" Activity rows in the app
- [x] `@@RUN` and `@@DONE@@` in `parseChat` and the session prompt (which lists the allowlist)
- [x] `parseCommand` on shell-quote: rejects operators, `$`/backticks, globs, comments, env assignments, newlines, >1,000 chars; desktop re-checks argv
- [x] Allowlist of argv prefixes per project, edited only in the app; defaults suggested from `package.json` and confirmed by the user
- [x] Executable resolved on PATH; project-local binaries refused unless that exact path is allowlisted
- [x] `spawn` with `shell: false`, no stdin, cwd = root; `cross-spawn` on Windows only; batch-file metacharacters refused
- [x] Env filter (`*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `AWS_*`, `OPENAI_*`, …) plus user patterns; `CI=1`, `FORCE_COLOR=0`
- [x] One command at a time; timeout (120s default, max 10 min) kills the process tree; 200 KB head+tail output cap; ANSI stripped; ~8k chat cut marked `[truncated]`
- [x] Live output to the app, the side panel and the RUN card
- [x] RUN cards: badge, Run (allowlisted only), Cancel, capped live output, Send output (no submit), "Add it to the allowlist in the Bridge app"
- [x] Full auto loop state machine: apply, read, run, one follow-up, click send, check the new user turn; ends on no actions or `@@DONE@@`
- [x] Pause reasons: held edits, command not allowed, failure (opt-in), too big, page error banner, disconnected, navigated, step limit, send not seen; Resume
- [x] Step limit 10 (max 25), `3 / 10` in the side panel and a page chip; Continue for N more
- [x] At least 3s between auto-sends, no other delay
- [x] Stop in the side panel, the app and the page chip: cancels the command, halts the loop, reverts nothing
- [x] Every loop step in the app's Activity, grouped by run; tab close or reload reports the run stopped
- [x] Desktop UI: mode switch, allowlist editor with suggestions, gated files and env editors, timeout/step limit/pause on failure, live output, loop status, Stop
- [x] Tests: argv parsing and near-miss allowlist matches, env filter, executable resolution, process tree kill, output cap, Windows escaping, server enforcement, gated files, Full auto resets, loop state machine (fake page), parser
- [x] `e2e/chat.cjs`: allowlist confirmed in the app, Auto-apply with a gated file and Undo all, a 2-step Full auto run to `@@DONE@@`, End session back to Manual
- [ ] Windows CI run of the `.cmd` round-trip and batch-argument tests (written; skip on macOS/Linux)
- [x] Live chatgpt.com (Oct 2026 layout): RUN/READ/diff cards, Run + Send output, Apply/Undo, Auto-apply + Undo all, a Full auto run to `@@DONE@@` (send button, send confirmation)
- [x] Fixes from the live run: newer layout selectors, code block header skipped, send button wait, send confirmed by composer emptying or a reply, launcher `npm_*` env dropped; Copy diagnostics (dev) in the side panel
- [ ] Live checks still open: step limit + Continue, Stop during a running command, a command that isn't allowed, the error banner selector

## Phase 6: App UI polish

- [x] Phases renumbered in PLAN.md: 7 is security hardening, 8 is packaging and release
- [x] Step 0: login shell PATH read once at startup (`$SHELL -ilc env`, 5s timeout, markers), fallback with a warning in Settings, PATH override field; tests for `.zshrc` junk, timeout, fallback
- [x] Protocol v4: `list`, `stat`, `delete`, `rename`, `watch`, `file_changed`, `session_start`, `read.bom`, `config.instance`; codes `encoding`, `project-missing`

### Delete and rename

- [x] `@@DELETE path@@` and `@@RENAME old -> new@@` in `parseChat` and the session prompt
- [x] `delete { path, baseHash }` and `rename { from, to, baseHash }`: sandbox, denylist, gated list, `exists` on a taken target, parents created inside the sandbox, case-only rename
- [x] Backed up first; undo restores (with conflict checks and the app's forced undo)
- [x] Never automatic: the server refuses `trigger: 'auto'` in every mode; Full auto pauses with `needs-click`
- [x] DELETE card (path, size, red) and RENAME card (`old → new`), Delete file / Rename / Reject / Undo

### Files in context and watcher

- [x] chokidar watcher on the open project: denylist, `.gitignore`, skip dirs, debounced, capped at 20,000 entries with polling of the files in context past that
- [x] `file_changed` pushed to the extension: stale markers, pending cards re-read and pre-flag conflicts
- [x] Side panel Files in context: size per file, `changed` / `deleted`, Resend changed, Remove from list; the chat's own changes don't go stale

### Desktop app polish

- [x] Layout: left nav (Session, Activity, Settings), header with project switcher, connection and mode, Stop on every page while Full auto runs
- [x] First-run checklist (pair, project, commands, session) that ticks itself, dismissible, Help → Getting started
- [x] Activity: kind filters, path search, grouped by loop run, detail with diff viewer or full output, Undo from the detail
- [x] Settings sections: Connection, Project, Commands (allowlist, timeout, env, PATH), Full auto, Backups (retention, open folder, clear), Appearance (system/light/dark)
- [x] Empty states, loading placeholders, plain-language text for every error code, toasts for background events
- [x] Single-instance lock, window bounds remembered, native menu (About, Settings ⌘,, Open folder ⌘O, Stop ⌘.)
- [x] Accessibility: keyboard everywhere, focus rings, labelled icon buttons, WCAG AA token contrast in both themes, reduced motion

### Extension polish

- [x] Side panel sections: Connection, Session, Mode / Full auto, Command, Requests (with Show), Files in context, Send files; plain copy for every status and pause reason; loading state
- [x] Cards: shared header and badges, collapse, keyboard focus kept, Copy path, applied time
- [x] Page chip: mode, step count and Stop in Full auto, draggable to a remembered corner

### Edge cases

- [x] Project folder deleted, moved or unmounted: "Project missing", every op fails with `project-missing`, recovers on return
- [x] Case-only rename on a case-insensitive disk
- [x] Non-UTF-8 refused (`encoding`) for reads and writes; BOM kept; trailing newline kept; empty files
- [x] Same path twice in one reply: both cards warn, Apply all and Auto-apply take the last; no-op edit `unchanged`; binary or huge content refused on the card
- [x] Large repos: side panel tree loads a folder at a time
- [x] One tab per session: "Session active in another tab" with Move here
- [x] Extension reloaded mid-session: UI removed, "Reload the page" notice
- [x] App restarted mid-session: session kept, loop pauses with `app-restarted`; sleep/wake: socket kept, reconnect at once, loop paused mid-step (`slept`)
- [x] Long conversations: remounted messages keep their cards, acted on once
- [x] Deleted conversation or 404: session ends (`chat-gone`)

### Tests

- [x] Vitest: delete/rename with sandbox and undo cases, watcher and stale logic, content edge cases, sessions/tabs, loop pauses, controller remount/reload/tabs, copy for every code and pause reason
- [x] Testing Library: onboarding, Activity filters and detail, Settings forms, mode switch with native confirm, app shell; axe on every page in both themes; token contrast test
- [x] `e2e/phase6.cjs`: checklist, delete and rename with undo, stale files with Resend changed, two tabs with Move here, extension reload; `chat.cjs`, `project.cjs`, `run.cjs` updated for the new layout
- [x] README screenshots of the app and the cards in light and dark (`e2e/screenshots.cjs`)
- [ ] Manual run of the Phase 6 script on real chatgpt.com (README / e2e README)

## Phase 7: Security hardening

### Step 0: live-test fixes

- [x] Navigating to a new or different chat ends the tab's session; Start session re-locates the tab and always inserts when there's no active session (tests: A → new chat → Start, A → B → Start, `locate`)
- [x] Auto-apply carries over between sessions; only Full auto resets, with a toast in the app and a note in the side panel (tests: `noteSession`, toast)
- [x] Result rows coloured by kind (Created green `+`, Modified pencil, Renamed arrow, Deleted red trash, struck); no check icon; cards, Activity, Session page, side panel stats (tests)
- [x] Page chip: a dot outside Full auto that opens on hover or focus; bottom corners kept clear of the composer and banners, re-measured on resize and each poll (tests)
- [x] `e2e/sessions.cjs`: Start session after client-side navigation to a new chat and to another chat
- [x] `e2e/stale.cjs`: send a file, edit it on disk, `changed` mark in the panel, Resend changed inserts the new content

- [x] Security review against PLAN.md "Security model"; threat model, controls and known limits in SECURITY.md
- [x] Upgrade Electron to a supported major (34 → 44, done at the start of Phase 2)
- [x] E2E smoke test: the parser runs in the content script, apply and undo work against a temp project (`chat.cjs`, `phase6.cjs`, now in CI)
- [x] Keep the pairing key out of content-script reach (moved to the worker's IndexedDB at the start of Phase 5)

### Pairing

- [x] Protocol v5: ECDH pairing (`/pair { code, publicKey }`, `/pair/confirm { proof }`); the app's key generated once and kept with `safeStorage`
- [x] Fingerprint (8 hex) shown in the app and the side panel; confirmed in the app, then the extension; nothing kept before both; Cancel on both sides
- [x] Old (v1) pairing files read as unpaired; tests: same key and fingerprint both sides, relay/squatter mismatch, confirm order, wrong proof, cancel, expiry, previous key kept until confirmed

### Filesystem

- [x] Hard links refused (`hardlink`) for read, stat, modify, delete and rename sources, and undo
- [x] Target folder re-checked right before every rename, link and remove; `O_NOFOLLOW` opens; race tests swap the folder for a symlink at commit time
- [x] userData `0700`, settings/pairing/server key `0600`, backups and op log `0700`/`0600`; checked and tightened at startup

### Commands

- [x] Exact-match allowlist, `*` for extra arguments; old entries migrated to `*` with a one-time note in Settings
- [x] `DENIED_FLAGS` table (git, node, npm/pnpm/yarn, npx/pnpx/bunx), checked on argv and the resolved program, on the RUN card and in Settings
- [x] Secret redaction in everything inserted into the chat; count on cards and in the side panel; Full auto logs it and still sends
- [x] Output backpressure: a flooding command pauses per event-loop turn; capped at 200 KB

### Server

- [x] `maxPayload` from the largest message (6 MiB + 64 KiB), 2 connections, 10s HTTP timeout, per-operation rate limits (`rate-limited`, retried by the extension)
- [x] fast-check fuzzing of the live server before and after auth, and of HTTP bodies; web-page origin, no origin and `Origin: null` refused everywhere

### Electron

- [x] `app.enableSandbox()`; permission request and check handlers deny all; `will-navigate`, `will-redirect`, `will-attach-webview` and new windows blocked for every web contents
- [x] Built `index.html` CSP tested (`default-src 'none'`, no `unsafe-*`)
- [x] Fuses via `afterPack` (`scripts/fuses.cjs`) and `verify:fuses`; tested on a synthetic binary
- [x] Every IPC handler: sender frame check and a zod schema per channel (`main/ipc.ts`), tested per channel
- [ ] Fuses verified on a packaged app (Phase 8)

### Extension

- [x] Extension page CSP; `externally_connectable` empty; manifest test updated
- [x] Every `chrome.runtime` listener checks the sender and parses with zod (panel port included); source test
- [x] `chrome.storage.local` holds no contents or secrets: `CardStore.set` validates; unit and e2e checks

### Supply chain and CI

- [x] `onlyBuiltDependencies` (electron, esbuild); `pnpm audit --prod --audit-level high` in CI
- [x] Actions pinned to commit SHAs, read-only token; Dependabot for npm, `e2e/` and Actions
- [x] e2e scripts in CI on Linux with `xvfb-run`
- [ ] First CI run of the new jobs (Linux e2e, coverage on Windows) on GitHub

### Tests

- [x] Property tests (fast-check): sandbox paths, argv parsing and allowlist matching, denied options, protocol schemas, the `@@` parser, redaction
- [x] Coverage thresholds: 90% lines for sandbox, runner, server, nonces, pairing, proofs, parser; 70% overall; `pnpm test:coverage` in CI
- [x] Regression tests: hard links, race re-check, exact allowlist and migration, denied flags, redaction (with false positives), rate limits, connection limits, fingerprint mismatch, every Electron handler

### Docs

- [x] SECURITY.md; PLAN.md "Phase 7 decisions"; README (SECURITY.md, fingerprint step, exact allowlist, redaction); CLAUDE.md rules; e2e README Phase 7 manual script
- [ ] Manual run of the Phase 7 script on real chatgpt.com (e2e README)

## Phase 8: Packaging and release

### Step 0: prep

- [x] electron-builder upgraded to 26.17.0 (newest stable 26.x)
- [x] One version everywhere: `pnpm version:set X.Y.Z` / `pnpm version:check [tag]` (`scripts/version.mjs`, tested)
- [x] Version handshake: `/health` reports `protocol`; a hello in another protocol is closed with 4009 `protocol N`; both sides show "Update the Bridge app" or "Update the extension" (tests in shared, server, connection, renderer)
- [x] e2e scripts on their own port range (47921–47930, `BRIDGE_E2E=1`) and temp userData, with their own extension build

### Desktop packaging

- [x] macOS dmg + zip, arm64 and x64 (separate builds), icon from `packages/shared/assets/icon.png`
- [x] Hardened runtime with `allow-jit` only; Developer ID signing, `notarytool` notarization and stapling when the five Apple secrets are set; otherwise ad-hoc, no hardened runtime, a printed warning (`scripts/package.mjs`, tested); a partial set fails
- [x] Windows NSIS x64, per-user, no elevation; signed when `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` are set
- [x] Linux AppImage x64
- [x] Fuses in `afterPack`; `verify:fuses` on every packaged app in the release workflow
- [x] asar on with integrity; no archive, e2e, fixtures, tests, source maps, TypeScript or dev dependencies; `check:package` lists the asar and fails on anything unexpected (tested)
- [x] Packaged builds named `Bridge` (userData `…/Bridge`), apart from `pnpm dev`'s `@bridge/desktop`
- [x] electron-updater, notify only (no download or install), on a click or an opt-in check at launch; off in dev and unsigned macOS builds; Settings → About with the version, **Check for updates** and the toggle; a toast when a newer version is found (tests)
- [x] Smoke test (`scripts/smoke.mjs`): launch, window loads, `/health` on 127.0.0.1, name `Bridge`, quit; in CI for every packaged app

### Extension packaging

- [x] `pnpm build:extension:release` → `release/bridge-extension-<v>.zip` (minified, no source maps, no `key`, only the build) and `-unpacked.zip` (with the `key`, for Load unpacked); checked and deterministic (tests)
- [x] `ALLOWED_EXTENSION_IDS` = dev ID + `STORE_EXTENSION_ID` (empty until the first upload), validated (tests); first-upload steps in RELEASE.md
- [x] `store/`: short and full description, single purpose, permission justifications, data-use answers, 128 icon, 1280×800 screenshots in light and dark, 440×280 promo tile (all from `e2e/screenshots.cjs`)

### Release workflow

- [x] On `v*`: the CI suite (reusable `ci.yml`, no secrets), version and changelog checks, packages on macOS, Windows and Linux, fuses, package contents and smoke tests, the extension zips, then a draft release with every file, `SHA256SUMS.txt` and the CHANGELOG section as notes
- [x] Secrets only in each platform's packaging step; read-only token except the release job; actions pinned to SHAs
- [ ] First run of the release workflow on GitHub (the tag push)

### Docs

- [x] README final: what and how, screenshots, install per OS with unsigned-build steps and why, extension (store placeholder and Load unpacked), pairing, modes with the Full auto warning, allowlist, updates, troubleshooting, where data lives, uninstall, links, not-affiliated note
- [x] PRIVACY.md (store privacy policy), CHANGELOG.md (1.0.0), RELEASE.md, LICENSE (MIT), docs/FAQ.md
- [x] PLAN.md "Phase 8 decisions", SECURITY.md (packaging, releases, update check), CLAUDE.md release rules

### Local release check (macOS, unsigned)

- [x] Installed from the dmg and launched through LaunchServices (`open`, as the Dock does): Settings shows PATH from the login shell, a `pnpm` RUN card runs (exit 0), pairing with the fingerprint works with the release's unpacked extension, `verify:fuses` passes on the installed app
- [x] Windows and Linux packages cross-built on macOS pass `check:package` (fuses, asar)
- [ ] Gatekeeper's right-click → Open on a downloaded (quarantined) unsigned dmg, and SmartScreen on Windows, by hand

## 1.0.1: Make the chat format stick

- [x] `buildSessionPrompt` rewritten from the template: rules before the tree, allowlist and tree filled in, under 1,500 characters before the tree (snapshot and length tests)
- [x] `FORMAT_FOOTER` ends context files, Send these files, Send output (`buildRunMessage`), Resend changed and Full auto follow-ups, once per message, inside the budget
- [x] Lenient parsing in inline code: `RUN`, `READ`, `DELETE`, `RENAME`, `DONE` without the closing `@@`; `FILE` only with a code block after it; `ChatParse.fixed` / `formatFixed`; `format fixed` badge on every card kind
- [x] Format issues (`ChatParse.issues`, `findFormatIssues`): typo'd or misplaced markers, unmarked blocks under a path, `@@FILE` without a block, placeholders; no false positives on prose, diffs, decorators or Bridge's own messages (tests)
- [x] Format card under the reply: "The chat didn’t use Bridge’s format" → **Send format reminder** inserts `FORMAT_REMINDER` without sending (tests)
- [x] Full auto: reminder instead of acting, once per step, twice per run, then pause `format-issues`; Resume acts on what was readable (tests); protocol v6 for the new pause reason
- [x] `.DS_Store`, `Thumbs.db`, `desktop.ini` hidden from `tree` and `list` through the default ignore list (tests)
- [x] `e2e/format.cjs` (in CI); `chat.cjs` and `phase6.cjs` follow the new prompt
- [x] Version 1.0.1 (`pnpm version:set 1.0.1`), CHANGELOG, PLAN.md "1.0.1 decisions", DESIGN.md "Format card"
- [x] Manual run on the real chatgpt.com (e2e README "1.0.1 on the real chatgpt.com")
- [x] Follow-up: blank marker values (`@@RUN   @@`, `` `@@RUN @` ``) read nothing (tests; the `parseChat` property test had caught it)

## 1.1.0: Install and catch up after sleep

### The install command

- [x] `suggestInstall`: manager from `packageManager`, then `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock(b)`, npm with none; `<pm> install` first among the suggestions, ticked, exact (tests per lockfile and none)
- [x] `isInstallCommand` (shared): bare install of npm, pnpm, yarn or bun; `npm install lodash`, `npm i`, `npx`, `dlx`, `npm create` refused under the exact entry (tests)
- [x] Install timeout 300s by default (5s–10 min), only for install commands (`CommandService`, settings, IPC, Settings field; tests)
- [x] One-time "Add `<pm> install` to the allowlist?" note for lists confirmed before 1.1.0, Add and Dismiss (`installNoteSeen`, `answerInstallNote`; tests)
- [x] Session prompt: "After changing package.json, run the install command" when it's allowlisted (test; rules still under 1,500 characters)
- [x] `package.json` and lockfiles stay gated in every mode (unchanged)

### Catch up after sleep

- [x] Protocol v7: `config.catchUpAfterSleep`; pause reasons `stalled`, `interrupted`, `command-interrupted`; `loop_report` `detail`, `pageContinue`, `note`
- [x] Settings → Full auto: "Catch up automatically after sleep", on by default; off keeps the 1.0 pause-and-Resume (tests)
- [x] On wake: reconnect and re-scan; a streaming reply is waited for ("Waiting for the chat to finish (resumed after sleep)" on the chip, side panel and app), no pause on a lost connection within 2 minutes, a reply that finished meanwhile acted on ("Caught up after sleep") (tests)
- [x] Stall: no new text for 60s after waking → Stop & continue on its own once, then pause `stalled` with **Stop & continue** (tests)
- [x] Interrupted reply: only whole blocks applied, the cut-off file held as partial; continuation names the last complete marker and the cut-off file; page's Continue generating preferred; at most once per interruption, then pause with **Resume** (tests: loop, parser, prompts, controller on `interrupted.html`, e2e)
- [x] Command running at sleep: cancelled, pause `command-interrupted` with **Re-run** and **Skip** ("The command `cmd` was interrupted and skipped.") (tests)
- [x] Changed conversation, session or project: stays paused with the existing reason (test)
- [x] Selectors: stop button (newer layout), Continue generating (test ids, then text), in-turn errors, interrupted turn states, network-style banners; fixture `interrupted.html` (tests)
- [x] Interrupted card in every mode: where it stopped, Continue generating first, **Insert continuation** (never sends outside Full auto) (tests)
- [x] `e2e/catchup.cjs` (in CI): install pre-ticked and the prompt line, a cut-off reply in Full auto (whole file applied, continuation sent), a second cut pausing, Resume sending it
- [x] Version 1.1.0, CHANGELOG, PLAN.md "1.1.0 decisions", SECURITY.md, README, DESIGN.md "Interrupted card"
- [ ] Manual run on the real chatgpt.com (e2e README "1.1.0 on the real chatgpt.com"): install, sleep with the lid closed, offline mid-reply

## 1.2.0-beta.1: Beta channel for testers

### Beta pre-releases

- [x] `pnpm version:set` / `version:check` accept `MAJOR.MINOR.PATCH-beta.N` (and nothing else); `parseVersion` in shared has the same rule (tests, including a check that both agree)
- [x] Extension manifest: `version` numbers only, `version_name` the full beta version (`manifestVersion`; tests in shared, `manifest.test.ts`, `releaseProblems`)
- [x] The app shows `1.2.0-beta.1` in Settings → About; the side panel shows it at the bottom (`version_name`)
- [x] `v*-beta.*` tags: draft pre-release, `--latest=false`, notes start with a BETA.md line (`scripts/release-flags.mjs`); normal tags unchanged; a bad tag fails in the version job
- [x] `release-flags.test.mjs` runs the workflow's notes and create steps from `release.yml` under bash with a stand-in `gh`, for a release and a beta tag
- [x] A beta builds only `bridge-extension-<v>-unpacked.zip` (fixed ID), no store zip (`releaseBuilds`, tested)
- [x] Settings → About → Update channel (Stable / Beta): beta builds default to Beta; Stable never offers a beta; Beta offers newer betas and releases (`offersUpdate`, `Updates`, settings, IPC, renderer; tests)

### Reporting problems

- [x] Help → Copy diagnostics and Settings → About → Copy diagnostics: versions, protocol, OS and arch, browser, mode, connection, last 50 log lines; no file contents, tokens or keys; paths with `~`; the whole block redacted (`appDiagnostics`; tests with a fake secret in a log fixture)
- [x] Side panel → Copy diagnostics: extension and app versions, protocol, OS and arch, browser (client hints), mode, connection, chat tab, last 50 worker events (memory only); `diagnostics` request with a zod schema (tests)
- [x] App log `userData/logs/bridge.log`, `0700`/`0600`, rotated at 5 MB, 3 files, every line through `logLine`; Help → Open logs folder (tests: rotation, redaction, reading back the tail, write failures)
- [x] `.github/ISSUE_TEMPLATE/`: Beta bug report (OS, version, steps, happened vs expected, diagnostics), Beta feedback, security link
- [x] e2e: `run.cjs` checks both diagnostics blocks, the panel's version and the log file after pairing

### Docs

- [x] BETA.md: download, install per OS (Mac chip, right-click → Open, quarantine fix; SmartScreen and why; AppImage, FUSE, Ubuntu 24.04 AppArmor), extension (Load unpacked in Chrome, Edge, Brave; pin), pairing with fingerprint screenshots, 15-minute checklist, Free/Go tips, known issues, reporting (templates, or diagnostics to whoever invited you), uninstall per OS; linked from the top of README
- [x] Pairing screenshots for BETA.md from `e2e/screenshots.cjs` (`docs/screenshots/beta/`)
- [x] Version 1.2.0-beta.1, CHANGELOG, RELEASE.md "Beta release", PLAN.md "Beta channel decisions", SECURITY.md, PRIVACY.md (logs, diagnostics), DESIGN.md, README, CLAUDE.md release rule
- [x] First beta run of the release workflow on GitHub (the `v1.2.0-beta.1` tag push): ran, and failed on unsigned macOS packaging and a hung Linux smoke test (fixed in 1.2.0-beta.2)
- [ ] BETA.md followed start to finish by a tester on macOS, Windows and Linux

## 1.2.0-beta.2: Release workflow fixes

- [x] `package.mjs`: signing variables that are set but empty are dropped before electron-builder runs (`builderEnv`); unsigned keeps `CSC_IDENTITY_AUTO_DISCOVERY=false` (test: empty secrets build unsigned and pass nothing on)
- [x] `smoke.mjs`: the app is spawned detached; pass or fail, its process group gets SIGTERM, then SIGKILL after up to 5s (`taskkill /T /F` on Windows), and the script exits with its code; a hard 3-minute timeout (tests with a fake app whose SIGTERM-ignoring helper holds the pipes: passing and never ready)
- [x] `timeout-minutes` on every job: 30 for packaging, 20 for the rest (ci.yml's jobs cover the reusable `checks` call); `repo.test.mjs` checks it
- [x] Version 1.2.0-beta.2, CHANGELOG
- [x] Release workflow run for `v1.2.0-beta.2` on GitHub: ran, and failed only on the mac x64 smoke test under Rosetta (fixed in 1.2.0-beta.3)

## 1.2.0-beta.3: Mac x64 smoke test, release dry run

- [x] `smoke.mjs`: a fresh temp `--user-data-dir` per app; the next app starts only after the previous one's process group is gone and its port is free (test: two runs on a fixed port, no overlap, different userData)
- [x] `smoke.mjs`: 120s window-load timeout for an x64 Mac app on an arm64 Mac (`loadTimeoutFor`, from the Mach-O header; tests), 90s otherwise; 3-minute hard cap per app
- [x] `release.yml`: mac x64 smoke test dropped after it timed out again on its own with 120s (dry run); x64 keeps `verify:fuses` and `check:package`; RELEASE.md and PLAN.md say so
- [x] `release.yml`: `workflow_dispatch` dry run (builds, verifies, smoke-tests and uploads everything; no release); `release` job on tag pushes only; tests for the `Tag` and dry-run steps
- [x] RELEASE.md "Dry run", run before tagging; PLAN.md
- [x] Version 1.2.0-beta.3, CHANGELOG
- [x] Dry run on GitHub: mac x64 smoke still timed out under Rosetta (step dropped, above); everything else passed
- [x] Dry run on GitHub green without the x64 smoke step (run 39947867132; `release` skipped, `dry-run` passed)
- [ ] Release workflow run for `v1.2.0-beta.3` on GitHub: pre-release, not Latest, unpacked zip only

## Install instructions in every release

- [x] `scripts/release/install-notes.md`: one template for the notes' **How to install** (file table, which Mac, unsigned-app steps, Load unpacked, pairing, files to ignore, links) and `Bridge-<version>-INSTALL.md` (plus troubleshooting and uninstall); `beta` / `stable` / `full` blocks
- [x] `scripts/install-notes.mjs`: file names from electron-builder.yml's `artifactName` and `releaseBuilds()`; `notes`, `write`, `check` (tests: beta and stable filled, nothing left over, names match the workflow's globs and BETA.md)
- [x] `release.yml`: notes start with How to install, then the CHANGELOG under What's new; INSTALL.md attached and in `SHA256SUMS.txt`; the release fails if the notes name a missing file; dry run shows notes and INSTALL.md in the summary and uploads both (fake `gh` tests)
- [x] `README.txt` at the root of both extension zips; `releaseProblems` requires it and `manifest.json` at the root (tests); the beta.3 zip loads unpacked in Chrome for Testing with no warnings or errors
- [x] RELEASE.md "Release notes", CHANGELOG; README screenshots removed
- [x] Dry run on GitHub green with the notes and INSTALL.md (run 39980326869; `check` passed against the real build files, INSTALL.md in SHA256SUMS.txt, README.txt in the zip)
- [ ] How to install pasted into the `v1.2.0-beta.3` release notes by hand

## 1.3.0-beta.1: Dev servers, assets, a hands-off Full auto

### Full auto approvals

- [x] Found why requested files waited for a click: a reply that finished while the config was null was dropped by `ChatController.act`; also pauses before reading, reminder-only format replies, and rebuilt READ cards (PLAN.md "1.3.0 decisions")
- [x] Replies without a config wait for it (`unacted`); files and images are read before any pause; a format reminder carries the files; the newest READ card is marked sent; protected files reported as refused without pausing (tests: controller, loop)
- [x] Settings → Full auto → Also approve automatically: deletes and renames, gated files, partial-looking files; off by default; native dialog with the risk on turning one on; risk text while on (tests: renderer)
- [x] Enforced by the app (`writeRefusal`, `changeRefusal`, `guardedFiles`); never automatic: off-allowlist commands, downloads, denylisted paths, conflicts (tests: server-level `assets.test.ts`, loop)
- [x] Activity labels automatic approvals "auto-approved"; the extension's claim kept only while its setting is on (tests)

### Background processes

- [x] Allowlist kinds: `backgroundAllowlists`, the Background checkbox, dev/start/serve/preview/watch suggested as background (`looksLikeBackground`); `background-only` / `not-background` (tests)
- [x] `@@START`, `@@STOP`, `@@LOGS` in the parser (lenient forms, format issues) and the session prompt (tests)
- [x] `BackgroundRunner`: no timeout, 3 at most, restart instead of a duplicate, process trees killed, ready URL, 2,000 redacted lines (tests with real processes and helpers)
- [x] Same rules as `@@RUN` (`CommandService.check`/`locate`): allowlist, denied options, mode, filtered env, project root, `shell: false` (tests)
- [x] Process cards (Start / Restart / Stop / Send logs), the app's Session page and the side panel (URL, uptime, Stop, View logs) (tests)
- [x] Full auto: starts and stops in order, waits for the URL, sends logs, and errors printed after edits (tests)
- [x] Stopped on session end, project switch, quit (waits) and sleep over 30 minutes (`BackgroundLifecycle`; tests with process trees)

### Assets

- [x] `upload` + `write_binary`: chunks in memory only, size and hash checked, dropped when refused; sandbox, denylist, gated files, backups, undo, 20 MB, type from the bytes (tests)
- [x] Generated images: Save to project card prefilled from `@@ASSET`, read from the page with no new permission, re-encoded to the path's type, auto-saved in Auto-apply and Full auto (tests; e2e)
- [x] `@@DOWNLOAD`: click only in every mode, https only and on every redirect, no local names or addresses (on the connection's own lookup), 20 MB, sniffed types, SVG scan (tests; e2e)
- [x] `read_binary` and attachments: Send files → Attach, READ cards attach images, Full auto attaches and waits for the upload (tests; e2e with a file input)
- [x] Thumbnails: Save card, downloaded images, and the app's Activity detail

### Step limit

- [x] Default 25 (1–100), Unlimited with a one-time note, saved 10 read as 25 once (tests)
- [x] Loop guard: same failure 3 times in a row, same file and content 3 times, with or without a limit (tests; e2e)

### Checks and docs

- [x] Protocol v8; format, lint, typecheck, tests with coverage, build
- [x] `e2e/assets.cjs` (dev server, logs, restart, Save to project, Attach, downloads, Full auto with requested files, dev server errors, an auto-approved delete, Unlimited, the loop guard, a download pause, End session stopping the tree); the other e2e scripts still pass
- [x] Session prompt, PLAN.md, SECURITY.md, PRIVACY.md, README.md, BETA.md, DESIGN.md, CHANGELOG, e2e README, CI
- [x] Version 1.3.0-beta.1
- [ ] Release dry run on GitHub
- [ ] Manual run on the real chatgpt.com (e2e README "1.3.0 on the real chatgpt.com"): generated image selectors, the file input, dev server errors

## Landing page (`apps/site`)

- [x] `@bridge/site`: Vite 7, React 18, TypeScript, Tailwind v4 (`@tailwindcss/vite`) with the tokens mapped into its theme; self-hosted Geist; private, outside `version:set`, the release workflow and the root build
- [x] Hero with an HTML diff card (Apply, Reject, Undo work), How it works, Modes (Full auto opt-in, Free/Go note), Safe by design (links SECURITY.md), Why Bridge exists (`TODO: Jaypee review`), FAQ, Support, footer with the oversized wordmark
- [x] Download: OS and architecture from the User-Agent and Client Hints, the matching installer first, files from the Releases API (cached in memory, stable over beta, `beta` badge), Releases-page fallback on error, rate limit or no release; unsigned-app notes linking BETA.md (tests)
- [x] Support: goals and links from `src/config/funding.ts`, "Funded, thank you!", buttons only for set links, GCash QR in a focus-trapped dialog, lazy image (tests); `.github/FUNDING.yml` commented out
- [x] System / Light / Dark switch, remembered in a try/catch; no analytics, cookies or third-party scripts; strict CSP in `vercel.json`
- [x] Prerendered HTML, hydrated; `SITE_URL` in one place for canonical, Open Graph, `robots.txt`, `sitemap.xml`; icons and the 1200×630 share image (`scripts/images.mjs`)
- [x] Lighthouse (local, gzip): mobile 99 / 100 / 96 / 100, desktop 100 / 100 / 96 / 100; the 96 is the rate-limited API call from the test machine
- [x] CI: `changes` job (`scripts/ci-changes.mjs`, tests), `site` job (20 min), check and e2e skip site-only changes; Vercel `ignoreCommand`
- [x] Screenshots at phone, tablet and desktop in both themes (`docs/screenshots/site/`); the wordmark fills the width and is cut about 25% at every size, no horizontal scroll
- [x] `apps/site/README.md` (local, Vercel, DNS, new domain, funding), README link and "Why Bridge exists", PLAN.md "Landing page decisions", DESIGN.md "Landing page"
- [x] Redesign pass: display type scale, varied section layouts, green Download call to action, looping hero demo (pauses off screen, hidden or paused; final frame under reduced motion), scroll reveals, smooth FAQ, theme crossfade, SVG footer wordmark that fits every width, finished Support section, footer credit; `scripts/screenshots.mjs` checks 320–2560px and records the demo
- [ ] Vercel project and the `bridge.jpsoriaga.me` DNS record (by hand, `apps/site/README.md`)
- [ ] Funding links and the GCash QR (`src/config/funding.ts`, `public/gcash-qr.png`)
- [ ] Jaypee reviews the "Why Bridge exists" text
