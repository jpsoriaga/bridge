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
- **Preload** exposes one typed object, `window.bridge`, through `contextBridge`. Every method maps to one narrow IPC channel whose inputs are validated in main, and main checks that each call comes from its own window's top frame. Phase 2 exposes `version`, `getStatus`, `onStatus`, `startPairing` and `unpair`.
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
- **Limits.** HTTP bodies are capped at 1 KiB and WebSocket frames at 16 KiB (raise this in Phase 4 when file contents flow). Each socket gets 100 messages per 10s and is closed with code 4008 if it goes over.
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
   - Reject any path with a `.git` segment, or any file named `.env` or `.env.*`.
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

| #   | Phase                    | Goal                                                               | Deliverables                                                                                                                                                                              |
| --- | ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Monorepo setup           | `pnpm install && pnpm dev` runs both apps, which share one package | Workspace, strict TS, lint, format, tests, CI. `@bridge/shared` with types and the parser (tested). Hardened Electron shell. MV3 extension stub. Design tokens and logo. Docs             |
| 2   | Local server and pairing | The extension and desktop connect securely                         | WS server on 127.0.0.1 with Origin and token checks. Pairing-code flow. Protocol envelope and schemas in shared (zod). Background connection with reconnect. Status pill live in both UIs |
| 3   | Reading the chat         | Bridge sees edits as they arrive                                   | Message observer with end-of-stream detection. Parsing per message, deduped by message id. Read-only diff cards injected in a shadow root. Activity rows in the side panel                |
| 4   | Applying edits safely    | Manual mode works end to end                                       | Project picker. Path sandbox with tests for traversal, symlinks, `.git` and `.env`. Diff against disk. Apply and Reject with atomic writes. Per-edit undo history. Error states on cards  |
| 5   | Modes and undo           | Auto-apply is safe to leave on                                     | Mode switch persisted and synced between the desktop and the side panel. Auto-apply with Undo on every card. Files-in-context tree. Undo of a whole message                               |
| 6   | Sending context          | The chat can see your project                                      | "Start session" prompt with format rules. "Send files" picker that fills the composer with chosen files (size-capped). Basic `.gitignore`-aware file listing                              |
| 7   | Commands and full auto   | Close the loop                                                     | Allowlisted `spawn` runner. Command cards with "Run & send output". Full-auto loop with step limit, Stop and the step counter. Output truncation                                          |
| 8   | Hardening and release    | Safe to use daily                                                  | Security review against this doc. E2E smoke tests. Electron upgraded to a supported major. electron-builder mac and win packages. Extension zip. Docs pass                                |
