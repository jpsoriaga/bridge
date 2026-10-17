# Bridge plan

Bridge lets the ChatGPT web chat edit a local project. The chat writes whole files in a fixed `@@FILE` format. A Chrome extension on chatgpt.com spots those blocks and shows them as diff cards, and a desktop app writes them to disk inside a sandboxed project folder. You can review each edit, auto-apply with undo, or let a bounded loop apply edits and run allowlisted commands.

It's a personal tool. It runs only on your machine, talks only to `127.0.0.1`, and sends nothing anywhere else.

## Architecture

```
 chatgpt.com tab                         Chrome extension (MV3)                 Bridge desktop (Electron)
┌──────────────────────┐  DOM   ┌─────────────────────────────────┐  WS   ┌──────────────────────────────┐
│ assistant messages   │◀──────▶│ content script                  │       │ main process                 │
│ with @@FILE blocks   │        │  · watch messages, parse blocks │       │  · local server 127.0.0.1    │
│ injected diff cards  │        │  · inject cards, fill composer  │       │  · pairing / session         │
└──────────────────────┘        │        ▲ chrome.runtime         │       │  · path sandbox + writes     │
                                │        ▼                        │       │  · undo history              │
                                │ background service worker ──────┼──────▶│  · command runner (allowlist)│
                                │  · owns the desktop connection  │       │         ▲ IPC (preload)      │
                                │        ▲                        │       │         ▼                    │
                                │        ▼                        │       │ renderer (React)             │
                                │ side panel (React)              │       │  · project, mode, activity   │
                                └─────────────────────────────────┘       └──────────────────────────────┘
                                                 shared: types, @@FILE parser, protocol, tokens (@bridge/shared)
```

### Desktop app (`apps/desktop`)

- **Main process** is the only part that touches the filesystem or spawns processes. It owns:
  - a local server bound to `127.0.0.1` on a fixed default port, with a fallback range
  - pairing and session state
  - the chosen project root
  - the path sandbox and atomic writes
  - per-edit undo history
  - the command runner
- **Preload** exposes one typed object, `window.bridge`, through `contextBridge`. Every method maps to one narrow IPC channel whose inputs are validated in main, and main checks that each call comes from its own window's top frame. Phase 3 exposes `version`, `getStatus`, `onStatus`, `startPairing`, `unpair`, `openFolder`, `openRecent(index)`, `getActivity`, `onActivity`, `undo(opId)`, `undoLast` and `setDenyPatterns`. None of them takes a filesystem path.
- **Renderer** is React. It's the control surface: pick the project, pair, choose the mode, watch activity, stop. It never gets Node or Electron objects.

### Extension (`apps/extension`)

- **Content script** runs only on `https://chatgpt.com/*`.
  - Watches the conversation with a `MutationObserver`, and waits for an assistant message to finish streaming before parsing it with `parseFileBlocks`.
  - Injects diff and command cards under the message, inside a shadow root so page CSS can't leak in.
  - Writes text into the composer (for "Send files" and "Run & send output").
  - Holds no secrets.
- **Background service worker** owns the single connection to the desktop app. It relays messages between the content script, the side panel and the desktop, and reconnects with backoff.
- **Side panel** mirrors the desktop state: connection, project, mode, files in context, activity, step counter and Stop.
- **Permissions**: `storage` (the pairing key in `chrome.storage.local`), `sidePanel` and `alarms` (wakes the worker to reconnect), plus one host permission, `http://127.0.0.1/*`, for the service worker's HTTP calls to the desktop (see "Phase 2 decisions"). The content script matches only chatgpt.com.

### Shared (`packages/shared`)

Pure TypeScript with no Node or DOM dependencies (except `styles.css`):

- types (`FileEdit`, `Mode`, …)
- the `@@FILE` parser
- the protocol message types and schemas (Phase 2)
- the logo geometry
- the design tokens

It's consumed as TS source through `workspace:*`. Vite bundles it into every target. electron-vite needs `externalizeDepsPlugin({ exclude: ['@bridge/shared'] })` so main and preload bundle it rather than `require()` a `.ts` file. With that in place, no build step or tsup is needed.

### How they talk

| Link                        | Transport                                                                     | Auth                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content script ↔ background | `chrome.runtime` messages                                                     | Chrome-internal                                                                                                                                               |
| Side panel ↔ background     | `chrome.runtime` port                                                         | Chrome-internal                                                                                                                                               |
| Background ↔ desktop        | WebSocket to `ws://127.0.0.1:<port>`, JSON envelopes `{v, id, type, payload}` | Server checks `Origin` is the extension's `chrome-extension://<id>`, then a mutual HMAC challenge over the pairing key. The token is never sent after pairing |
| Renderer ↔ main             | Electron IPC via the preload API                                              | Process boundary; main validates every payload                                                                                                                |

Pairing: the desktop shows a one-time code. You enter it in the side panel, which exchanges it for a long-lived token. Both sides keep only the token's SHA-256 (the "key") and prove they hold it with HMACs. Revoking it in the desktop drops the socket.

## Phase 2 decisions

How the connection works, and why.

- **Server.** Fastify 5 with `@fastify/websocket`, bound to `127.0.0.1` (never `0.0.0.0` or `localhost`). It tries `47821` first, then the next free port up to `47830` (`DEFAULT_PORT` and `PORT_RANGE` in `@bridge/shared`), and saves the bound port to `settings.json` in userData. Fastify's logger is off, so nothing logs tokens or codes.
- **Routes.** `GET /health` returns only `{ name: "bridge", version }`. `POST /pair`, `POST /unpair/challenge` and `POST /unpair` are HTTP, and everything else goes over `GET /ws`. Unpairing from the extension uses the same proof exchange as the socket (see "Socket auth"), split over two calls: `/unpair/challenge { nonce }` returns `{ proof, serverNonce }`, and the extension checks `proof` before sending `/unpair { serverNonce, proof }`. Server nonces from `/unpair/challenge` expire after 30s and are single use.
- **Host check.** Every request, including the WebSocket upgrade, must carry `Host: 127.0.0.1:<port>` exactly, or it gets a 421. This is the DNS-rebinding guard: a rebinding page sends its own hostname.
- **Origin check.** `/pair`, `/unpair` and `/ws` require `Origin: chrome-extension://<id>` from `ALLOWED_EXTENSION_IDS` (desktop `src/main/server/config.ts`, the only list). The manifest `key` pins the unpacked ID to `BRIDGE_EXTENSION_ID` in shared, and a test checks the key really produces that ID. If the extension is ever published to the Web Store, add the store ID to that list.
- **No CORS.** The server never sends `Access-Control-*` headers. It accepts only `application/json` bodies (`text/plain` gets a 415), so a web page can't send a "simple" cross-origin POST, and it couldn't read the reply anyway.
- **Limits.** HTTP bodies are capped at 1 KiB. WebSocket frames were 16 KiB in Phase 2 and are 8 MiB from Phase 3, because a write carries up to 1 MB of content and JSON escaping can grow it several times; the content's real UTF-8 size is checked after parsing. Each socket gets 100 messages per 10s and is closed with code 4008 if it goes over.
- **Pairing codes.** Six digits from `crypto.randomInt`, valid for 2 minutes, used once, compared with `timingSafeEqual`. After 5 wrong codes, `/pair` is locked for 60s and **the current code is discarded**, so no code ever gets more than 5 guesses. A new pairing replaces the old token and closes its socket (one extension at a time).
- **Token and key.** The token is 32 random bytes, hex, and exists only in the `/pair` response. Both sides immediately keep its SHA-256 instead (`tokenHash`, "the key") and use it as the HMAC-SHA256 key for every proof. The desktop stores the key in `pairing.json` under userData, encrypted with `safeStorage` when it's available. Without a keyring (some Linux setups) it falls back to plain hex in a `0600` file. That fallback now exposes the key itself, so it's as sensitive as the extension's copy in `chrome.storage.local`, which Chrome doesn't encrypt either. Both are readable only by the local user.
- **Socket auth (mutual challenge, protocol v2).** The token is never sent on the socket.
  1. Extension → `hello { nonce }` (32 random bytes).
  2. Desktop → `challenge { proof: HMAC(key, input('server', 'ws', port, nonce)), serverNonce }`.
  3. The extension verifies `proof` with `crypto.subtle.verify` (constant time). If it's wrong, it closes and never tries that port again until the user retries or pairs. It doesn't send anything else.
  4. Extension → `auth { proof: HMAC(key, input('client', 'ws', port, serverNonce)) }`. The desktop checks it with `timingSafeEqual` and replies `auth_ok`.

  `input` is `proofInput()` in shared: `bridge/v2/<role>/<purpose>/<port>/<nonce>`. The role and purpose stop a proof from one step being reflected into another (for example, opening a second socket to get the server to sign your server nonce). The port binds the proof to the socket the extension dialled, so a process squatting another port in the range can't relay the real app's proof. Client nonces are remembered for 10 minutes (up to 1024) and a repeat is refused with `replayed_nonce`. Each server nonce belongs to one socket and dies with it.

  The whole handshake must finish within 5s. Failures send `auth_error` and close with 4000 (timeout), 4002 (wrong message order or replayed nonce) or 4001 (bad proof, not paired, revoked or replaced). The extension forgets its key on 4001 **only if the server already proved itself on that socket**, so a squatter can't make it forget. An unpaired app (it can't prove anything) leaves the extension in the `error` state, and the side panel suggests unpairing and pairing again. After auth, invalid messages get an `error` reply and are dropped. A socket with no traffic for 60s is closed.

- **Protocol.** All messages are zod schemas in `@bridge/shared` (`protocol.ts`), with strict objects, so unknown keys are rejected too. Both sides validate everything they receive and drop what doesn't parse.
- **Service worker.** The connection lives in the background worker, not the content script, so chatgpt.com's CSP and local-network rules don't apply and the Origin is the extension's. It pings every 20s, which also keeps the MV3 worker alive while connected, and drops the socket if nothing arrives for 50s. It reconnects with backoff (1s, 2s, 4s … 30s), and the side panel opening skips the wait.
- **Port pinning.** The extension remembers the port of the last server that passed the challenge (first the one it paired on). It tries that port first and scans 47821–47830 in order only if the pinned port fails. It accepts only a server that passes the challenge, and re-pins to it. Before pairing nothing can prove itself, so `/pair` goes to the first port whose `/health` answers.
- **Wake-up alarm.** While paired and not connected, the worker keeps a 1-minute `chrome.alarms` alarm named `reconnect`. It's cleared once connected or unpaired. This costs the `alarms` permission and means a stopped worker reconnects within a minute of the app starting, without waiting for the side panel or a chatgpt.com tab.
- **`host_permissions: ["http://127.0.0.1/*"]` is needed**, but only for HTTP. Tested on Chromium 156 with the real worker: without it, `fetch` to `/health` and `/pair` fails (the response is cross-origin and the server sends no CORS headers), while `new WebSocket('ws://127.0.0.1:…')` opens either way. Sending CORS headers instead would loosen the server, and moving pairing onto the socket would mean dropping `/health` and `/pair` from the design. One loopback host permission is the smaller change. It covers every port, because the server's port can fall back.
- **Content script** only asks the worker for status (`get-status`) and logs it. The worker refuses every other request unless it comes from one of the extension's own pages.

Open points carried forward:

- Pairing itself is still trust-on-first-use: the 6-digit code is posted to whichever port answers `/health` first. A process squatting a lower port while you pair could see the code and race to redeem it within its 2 minutes. You'd notice (the app would stay "Not paired" or show another client connected), and re-pairing fixes it.
- Unpairing in the extension while the app is closed clears the key locally only. The desktop keeps it until you unpair or pair again there. That's harmless, because the key is gone from the extension.

## Phase 3 decisions

The project folder, the sandbox, and file access over the socket. Code: desktop `src/main/project/`.

- **Opening a folder.** Only main opens folders: **Open folder…** calls `dialog.showOpenDialog`, and recents are opened by index into main's own list, so the renderer never sends a path. Main refuses a file, the disk root, the home folder itself, and any folder that is, contains or sits inside userData (backups and the pairing key live there). `settings.json` keeps the open project and up to 5 recents, and the last project reopens on launch if it still exists.
- **What the extension sees.** `status` now carries `project: { name, path } | null`, with the home folder shortened to `~`, and is pushed again on every switch. Error replies never include an absolute path.
- **Sandbox (`sandbox.ts`).** Lexical checks first, on the NFC form of the path: a string, 1–1024 characters, no control characters (NUL included), not absolute (`/x`, `C:`, `\\srv`, `//srv`, `\x`), no backslash anywhere, no `:` (NTFS streams), no empty, `.` or `..` segments, no segment ending in a dot or space (Windows drops them, so `.git.` would open `.git`), and no Windows device names on Windows. Then the denylist. Then a walk from the real root, one component at a time, with `lstat`: a symlink is resolved with `realpath` and must land strictly inside the real root and outside the denylist; a dangling or looping link is refused; the first missing component ends the walk, so a new file's parent folders are created only under a real, checked directory. Sockets, FIFOs and devices are refused. NFC matters: U+212A KELVIN SIGN normalises to `K`, so `secret.\u212Aey` is caught as `*.key`.
- **Denylist.** `DEFAULT_DENYLIST` in `sandbox.ts` is the one list: `.git/`, `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `node_modules/`. It uses `.gitignore` syntax through the `ignore` package, ignoring case, and each path is tested as both a file and a folder. Users add patterns in Settings. Those live in a separate matcher, and `!` patterns are refused, so a user pattern can never re-allow a default. It stays in the desktop (not `@bridge/shared`) because only the desktop enforces it.
- **Error codes** are `FileErrorCode` in shared: `no-project`, `invalid-path`, `absolute-path`, `traversal`, `denied`, `outside-root`, `not-found`, `not-a-file`, `binary`, `too-large`, `conflict`, `exists`, `unknown-op`, `already-undone`, `io-error`. Sandbox refusals and failed writes and undos are logged in the activity list. A read that simply misses is not.
- **Operations.** Requests are `tree`, `read`, `write` and `undo` envelopes. The reply is `response { ok, result | error }` with the request's own `id`, and the extension checks `result` against `FILE_RESULTS[type]`. Writes and undos run one at a time behind a lock in `ProjectService`. There is no delete or rename yet.
  - `tree` walks depth-first, sorted by name. It honours every `.gitignore` on the way down, the denylist, and skips `dist`, `out`, `build` and `.next`. `node_modules` shows as one entry with `collapsed: true`. Symlinks are listed only if they stay inside and aren't denied, and symlinked folders are never descended. Caps are 5,000 entries and depth 12, with `truncated`.
  - `read`: refuses anything over 1 MB before reading it, and anything with a NUL in the first 8 KB (`binary`). Returns `{ content, hash, eol }`, where `hash` is the SHA-256 of the raw bytes and `eol` comes from the first line break.
  - `write`: with no `baseHash` it's a create. An existing file gives `exists`. With a `baseHash` it's a modify: a stale hash gives `conflict`, and so does a file that has disappeared. A modify keeps the file's EOL style and mode. Content is written to `.<name>.bridge-<random>.tmp` beside the target, fsynced, then moved into place: `rename` for a modify, and `link` for a create, which fails with `EEXIST` if a file appeared in the meantime. On filesystems without hard links, a create falls back to `copyFile` with `COPYFILE_EXCL`, which is exclusive but not atomic. The temp file is always removed.
- **Backups and undo.** `userData/backups/<projectId>/` (the first 16 hex characters of the SHA-256 of the real root) holds `log.json` and one `<opId>/` folder per write. For a modify the folder holds `before`, the old bytes. For a create it's empty. The order is: backup, write, then log. A crash in between leaves a backup with no log entry, which the next prune removes. Undo restores `before` or removes the created file, but only if the file still hashes to the write's `afterHash`. Otherwise it gives `conflict`. The app then asks in a native dialog ("Undo anyway" or "Cancel"), and forces the undo only if you confirm. An `undo` from the extension is never forced. Pruning drops ops older than 7 days or beyond the newest 500, whichever comes first, and runs on project open and after every write.
- **Dev field.** The side panel's file tester and the worker's `dev-file` request exist only when `import.meta.env.DEV` is true. `vite build --mode development` (what `pnpm dev` runs) leaves DEV false, so the extension's Vite config defines it in development mode. A production build has neither the UI nor the handler.

Open points carried forward:

- A local process that can write into the project could swap a checked folder for a symlink between the sandbox check and the write (TOCTOU). Bridge resolves each component just before using it, which keeps the window small but not zero. That threat (malware already writing to your project) is outside what Bridge defends against.
- A hard link inside the project to a file outside can't be told apart from a normal file. Reading one would read the outside file. Writes replace the directory entry (temp file plus rename), so they never modify the outside file.

## Modes

| Mode           | Edits                                                                   | Commands                                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manual**     | Shown as pending diff cards. Nothing is written until you click Apply.  | Shown as a command card. Runs only when you click "Run & send output".                                                                                                                                                                         |
| **Auto-apply** | Written as soon as the message finishes. The card shows Applied + Undo. | Same as Manual.                                                                                                                                                                                                                                |
| **Full auto**  | Written immediately, as in Auto-apply.                                  | Allowlisted commands run automatically, and their output is sent back as the next chat message. The loop continues until the chat stops proposing edits or commands, you press Stop, or the step limit (default 10, "Step N of M") is reached. |

Every mode uses the same path sandbox and allowlist. Modes only change _when_ things happen, never _what_ is allowed.

## Security model

These rules don't change between phases. CLAUDE.md repeats them.

1. **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0` or `localhost`. It rejects any request whose `Host` isn't `127.0.0.1:<port>` (DNS rebinding), any whose `Origin` isn't the allowlisted extension, and any message without a valid session token. Messages are size-capped and rate-limited.
2. **Path sandbox.** Every path from the chat is untrusted:
   - Reject absolute paths, drive letters, NUL, empty segments and any `..` segment.
   - Resolve against the project root, then `realpath` the deepest existing ancestor and require it to stay inside the root's realpath. This blocks symlinks that point out.
   - Reject anything on the denylist (`.git/`, `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `node_modules/`, plus the user's own patterns), ignoring case.
   - Cap file size. Writes are atomic (temp file plus rename).
3. **Commands** use `spawn(cmd, args, { shell: false, cwd: root })` with an allowlist of exact `argv` prefixes (e.g. `npm run build`, `npm test`, `pnpm lint`, `git status`, `git diff`). There's no shell, no string concatenation, a timeout, an output cap, and a scrubbed env.
4. **Electron**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, and a strict CSP (`default-src 'none'`). Window opening and navigation are denied, and all permission requests are refused.
5. **Extension**: minimal permissions, chatgpt.com only, no remote code, and no `eval`. Injected UI lives in a shadow root.
6. **No telemetry**, no analytics, and no network calls except loopback.
7. **No OpenAI or Codex branding.** Bridge is its own product. Refer to "the chat" in UI copy.

## The `@@FILE` format

Each edit is one whole file:

````
@@FILE src/hooks/useTheme.js@@
```js
...full file contents...
```
````

- The header is on its own line. The path is everything between `@@FILE ` and the closing `@@`, and may contain spaces. It's relative to the project root.
- The fence starts on the very next line. The language tag is optional. Backticks or tildes work, 3 or more.
- The block ends at a line made only of the same fence character, at least as long as the opener. Wrap a file that itself contains a triple-backtick fence in four backticks.
- Content is the text between the fences, plus a trailing newline. CRLF is normalised to LF.
- A block whose fence never closes is ignored. That's what you see mid-stream or in a truncated reply.
- The parser does no path validation. That's the desktop sandbox's job.
- Not yet supported: deletes, renames and partial patches. Possible later syntax is `@@DELETE path@@`.

The "Start session" prompt (Phase 6) teaches the chat this format and the rules (whole files only, one block per file, relative paths).

## Phases

| #   | Phase                    | Goal                                                               | Deliverables                                                                                                                                                                                                                     |
| --- | ------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Monorepo setup           | `pnpm install && pnpm dev` runs both apps, which share one package | Workspace, strict TS, lint, format, tests, CI. `@bridge/shared` with types and the parser (tested). Hardened Electron shell. MV3 extension stub. Design tokens and logo. Docs                                                    |
| 2   | Local server and pairing | The extension and desktop connect securely                         | WS server on 127.0.0.1 with Origin and token checks. Pairing-code flow. Protocol envelope and schemas in shared (zod). Background connection with reconnect. Status pill live in both UIs                                        |
| 3   | Project and files        | The extension can read and write inside one folder, with undo      | Folder picker and recents. Path sandbox with 40+ attack tests. `tree`, `read`, `write`, `undo` over the socket. Atomic writes with conflict checks. Backups and op log in userData. Activity list with undo. Dev-only test field |
| 4   | Reading the chat         | Bridge sees edits as they arrive and Manual mode works end to end  | Message observer with end-of-stream detection. Parsing per message, deduped by message id. Diff cards in a shadow root, diffed against `read`. Apply (`write` with `baseHash`) and Reject. Error states on cards                 |
| 5   | Modes and undo           | Auto-apply is safe to leave on                                     | Mode switch persisted and synced between the desktop and the side panel. Auto-apply with Undo on every card. Files-in-context tree. Undo of a whole message. Delete and rename                                                   |
| 6   | Sending context          | The chat can see your project                                      | "Start session" prompt with format rules. "Send files" picker that fills the composer with chosen files (size-capped), built on `tree` and `read`                                                                                |
| 7   | Commands and full auto   | Close the loop                                                     | Allowlisted `spawn` runner. Command cards with "Run & send output". Full-auto loop with step limit, Stop and the step counter. Output truncation                                                                                 |
| 8   | Hardening and release    | Safe to use daily                                                  | Security review against this doc. E2E smoke tests. Electron upgraded to a supported major. electron-builder mac and win packages. Extension zip. Docs pass                                                                       |
