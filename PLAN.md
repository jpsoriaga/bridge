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
- **Preload** exposes one typed object, `window.bridge`, through `contextBridge`. Every method maps to one narrow IPC channel whose inputs are validated in main, and main checks that each call comes from its own window's top frame. Phase 3 exposed `version`, `getStatus`, `onStatus`, `startPairing`, `unpair`, `openFolder`, `openRecent(index)`, `getActivity`, `onActivity`, `undo(opId)`, `undoLast` and `setDenyPatterns`; Phase 5 adds `setMode`, `setAllowlist`, `setGatedPatterns`, `setEnvPatterns`, `setRunSettings`, `cancelRun`, `stopLoop` and `onRunOutput`. None of them takes a filesystem path.
- **Renderer** is React. It's the control surface: pick the project, pair, choose the mode, watch activity, stop. It never gets Node or Electron objects.

### Extension (`apps/extension`)

- **Content script** runs only on `https://chatgpt.com/*`, in the top frame.
  - Watches the conversation with one debounced `MutationObserver`, waits for an assistant message to finish streaming, turns it into text (`messageToText`) and parses it with `parseChat`.
  - Injects diff, READ and Apply-all cards under the message, each in a closed shadow root so page CSS can't leak in or out.
  - Writes text into the composer (session prompt, files the chat asked for, "Send files", command output). Outside Full auto it never presses send; in Full auto the loop clicks the page's send button (see "Phase 5 decisions").
  - Holds no secrets and never touches `chrome.storage`. File access and card state go through the worker.
- **Background service worker** owns the single connection to the desktop app. It relays messages between the content script, the side panel and the desktop, reconnects with backoff, and owns chat sessions and card state.
- **Side panel** mirrors the desktop state: connection, project, the chat session in the active tab (start, end, stats), Send files, and later mode, step counter and Stop.
- **Permissions**: `storage` (sessions and card state in `chrome.storage.local`; tab bindings in `chrome.storage.session`; the pairing key is in the worker's IndexedDB, which needs no permission), `sidePanel` and `alarms` (wakes the worker to reconnect), plus one host permission, `http://127.0.0.1/*`, for the service worker's HTTP calls to the desktop (see "Phase 2 decisions"). The content script matches only chatgpt.com. `web_accessible_resources` has two entries, both matched to chatgpt.com only: the two card fonts with `use_dynamic_url`, and the content script's chunks (added by CRXJS, static because its loader imports them by URL).

### Shared (`packages/shared`)

Pure TypeScript with no Node or DOM dependencies (except `styles.css`):

- types (`FileEdit`, `Mode`, …)
- the chat parser (`parseChat`: `@@FILE`, `@@READ`, `@@CONTEXT`) and the text Bridge puts in the composer (`buildSessionPrompt`, `buildContextMessage`, `pickFence`)
- the diff helper (`diffFile`, on jsdiff)
- the protocol message types and schemas (Phase 2)
- the logo geometry
- the design tokens (`tokens.css`, imported by `styles.css`)

It's consumed as TS source through `workspace:*`. Vite bundles it into every target. electron-vite needs `externalizeDepsPlugin({ exclude: ['@bridge/shared'] })` so main and preload bundle it rather than `require()` a `.ts` file. With that in place, no build step or tsup is needed.

### How they talk

| Link                        | Transport                                                                     | Auth                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content script ↔ background | `chrome.runtime` messages, zod-validated both ways                            | Worker accepts only the top frame of an `https://chatgpt.com` tab, and only chat requests; file requests need an active session in that tab                   |
| Side panel ↔ background     | `chrome.runtime` port and messages                                            | Only the extension's own pages                                                                                                                                |
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
- **Token and key.** The token is 32 random bytes, hex, and exists only in the `/pair` response. Both sides immediately keep its SHA-256 instead (`tokenHash`, "the key") and use it as the HMAC-SHA256 key for every proof. The desktop stores the key in `pairing.json` under userData, encrypted with `safeStorage` when it's available. Without a keyring (some Linux setups) it falls back to plain hex in a `0600` file. That fallback now exposes the key itself, so it's as sensitive as the extension's copy in the service worker's IndexedDB (`chrome.storage.local` before Phase 5), which Chrome doesn't encrypt either. Both are readable only by the local user.
- **Socket auth (mutual challenge, protocol v2; v3 since Phase 5).** The token is never sent on the socket.
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

## Phase 4 decisions

Chat integration, Manual mode only. Code: `packages/shared/src/{parser,prompts,diff}.ts`, extension `src/content/chat/`, `src/background/{sessions,cards,senders}.ts`, `src/sidepanel/{SessionSection,SendFiles}.tsx`.

- **Nothing happens on its own.** Nothing is auto-submitted, auto-applied or sent without a click. Reading a file to show a diff or a READ card's sizes is the only thing that happens when a card appears.
- **Sessions.** Start session (side panel) needs a connected app, an open project and a chatgpt.com tab whose layout Bridge can read. It lists the tree, builds `buildSessionPrompt`, shows the character count first, and inserts it into the composer. A session belongs to a conversation (`/c/<id>`, also `/g/<gpt>/c/<id>`) and lives in `chrome.storage.local`. In a new chat it waits on the tab (`chrome.storage.session`) and binds when the URL gets an id. End session marks it ended: cards already shown stay but are disabled, and nothing new is parsed. Sessions are dropped 30 days after they start or end.
- **Only assistant messages.** The content script reads only `[data-message-author-role="assistant"]`. User messages, including files Bridge sent, are never parsed. The parser also skips `@@CONTEXT` blocks and any fence without a marker, so an echoed context block or an example inside a code block is never an edit.
- **One parser, no HTML regex.** `messageToText` walks the message in order: paragraphs and list items become lines, `<br>` a line break, inline `<code>` stays in backticks, `<strong>`/`<em>` become `__…__`/`_…_` (markdown turns `__init__.py` into bold "init"), and each `<pre>` becomes one fenced block of `code.textContent` (not the header with the language and Copy), with a fence longer than any backtick run inside. Prose lines that look like fences are escaped, so the Nth fence in the text is the Nth `<pre>`, which is where the card goes.
- **Streaming.** A message is parsed once it has no streaming marker and its turn shows the action buttons. If the page has no action buttons Bridge recognises, it falls back to "no stop button on the page". Mutations are debounced 250ms. A changed message text (regenerate, edit) rebuilds that message's cards.
- **Selectors** are all in `src/content/chat/selectors.ts`, each with fallbacks. If a chat page has a composer slot or turns but Bridge can't find the composer or any messages for 5 seconds, the tab reports `layout: unknown` and the side panel shows "Bridge can't read this page layout" instead of Start session.
- **Block keys** are `conversationId:messageId:slot:contentHash` (first 16 hex of SHA-256 over path and content). The slot is the block index, or `read` for the READ card (hashed over its paths). The worker keeps each card's state (`pending`, `applied`, `rejected`, `undone`, plus `opId` and counts; a READ card's `pending` or `sent`) under that key in `chrome.storage.local`, so a reload shows it as it was. Records not updated for 30 days are pruned on every write. A tab may only write card state for the conversation it has an active session in.
- **Cards** are built with `createElement` and text nodes only; nothing from the chat goes through `innerHTML`. Each lives in a **closed** shadow root after its code block, so page scripts can't reach in through `host.shadowRoot`. They're re-inserted when a re-render drops them. Tokens come from `@bridge/shared/tokens.css` with `:root` swapped for `:host`, plus copies keyed to the page's `html.dark` / `html.light`, so cards follow the page's theme.
- **Apply flow.** The card reads the file when it appears (content and hash, or `not-found` for a new file) and diffs it in the extension (`diffFile`; line endings ignored, since the desktop keeps each file's EOL). Apply writes with that `baseHash`. On `conflict` (or `exists`) the card re-reads, shows the new diff with an "updated since" note, and Apply sends the new hash. Undo sends `undo { opId }`, never forced. Sandbox refusals show the card as `blocked`. A `suspectedPartial` block needs a second click. Apply all (2+ applicable files, partial ones excluded) applies in order and stops at the first failure.
- **Composer.** Text goes in with a synthetic `paste` event carrying `text/plain`, which ProseMirror handles like a real paste. If the page doesn't handle it, `execCommand('insertText')` is the fallback, and an old `<textarea>` composer gets its value set through the prototype setter. Above 30,000 characters (`COMPOSER_WARN_CHARS`) the panel and READ card warn that the chat may turn the paste into an attachment or cut it.
- **Send files** (side panel) uses `tree` for a checkbox tree with a filter and a budget meter (file sizes plus format overhead), at most 50 files per send. The worker reads each and inserts them with `buildContextMessage`; refused files are listed by reason, not sent.
- **Messaging.** Every `chrome.runtime` message is a zod schema in `src/messages.ts`. The worker classifies the sender: an extension page (URL under `chrome-extension://<id>/`) or the content script in frame 0 of a tab whose URL origin is exactly `https://chatgpt.com`. Each gets its own request list. The content script accepts `insert-text` and `session-changed` only from the worker (no `sender.tab`). The worker proxies `read`, `write` and `undo` (and `tree` for the panel). No new server operation was added.
- **"via chat".** `write` gained an optional `source: 'chat'`, which the worker sets for card writes. The desktop stores it in the op log and the Activity list says "Modified · via chat".
- **Fonts.** Geist and Geist Mono (latin subsets) are loaded from the extension through `FontFace` on the page's `document.fonts`, because `@font-face` doesn't work inside a shadow root. If chatgpt.com's CSP blocks `chrome-extension://` fonts, the load fails quietly (a console note) and the token stacks fall back to `ui-sans-serif`/`system-ui` and `ui-monospace`. This hasn't been checked against the live site's CSP yet; the e2e stand-in page has no CSP. Since Phase 5 the fonts are emitted at fixed paths (`src/fonts.ts`) and listed with `use_dynamic_url: true`, so `chrome.runtime.getURL` hands out a per-session URL and the static one is refused (`e2e/chat.cjs` checks both).

Open points carried forward:

- chatgpt.com can change its markup at any time. The likeliest breaks are the turn action buttons (end-of-stream detection), the streaming class, and the code block layout inside `<pre>`. See `selectors.ts` and the fixtures README for how to refresh them.
- The adapter turns every `<strong>` into `__…__`, so a marker like `@@FILE a/**b**.ts@@` written without inline code would read as `a/__b__.ts`. The session prompt tells the chat to put markers in inline code, which avoids markdown entirely.
- `web_accessible_resources` still lets chatgpt.com detect that Bridge is installed, through the content script's chunk URLs (CRXJS's loader needs them static). The font URLs are dynamic since Phase 5. Nothing secret is exposed.
- `chrome.storage.local` is readable by content scripts by default. Since Phase 5 it no longer holds the pairing key (see "Phase 4 follow-ups"); sessions and card state are still there.

### Phase 4 follow-ups (done at the start of Phase 5)

- **Pairing key in IndexedDB.** `tokenHash` moved from `chrome.storage.local` to the service worker's IndexedDB (`bridge-keys`, `background/key-store.ts`). A content script's `indexedDB` is the page's (chatgpt.com's), so it can't open the extension's database, and `chrome.storage.local`, which content scripts can read, no longer holds the key. On the first read or write after the update, a key (or a Phase 2 raw token) left in `chrome.storage.local` is moved over once and deleted there. `src/content/isolation.test.ts` walks the content script's import graph and checks that it bundles no worker module, never touches `indexedDB` or `chrome.storage`, and that no content↔worker message carries a key.
- **Fonts on dynamic URLs.** See "Fonts" above.
- **READ card state** is saved like a diff card's (`pending` → `sent`), so a reload shows **Send again**.

## Phase 5 decisions

Modes, the command runner and Full auto. Code: shared `commands.ts`, `loop.ts`, `prompts.ts`; desktop `src/main/commands/`, `src/main/policy.ts`; extension `src/content/chat/{loop,page}.ts`, `cards/{run-card,message-bar,loop-chip}.ts`, `src/sidepanel/FullAuto.tsx`.

**Protocol v3.** `write` carries `trigger: 'click' | 'auto'` (and an optional `loopId`). New requests `run { argv, trigger, loopId? }` (reply `{ runId }`) and `run_cancel { runId }`; events `run_output { runId, chunk }` and `run_exit { runId, argv, status, exitCode, signal, durationMs, output, truncated }`. `status` carries `config { mode, allowlist, stepLimit, pauseOnFailure, running }`. The extension sends `loop_report` (state, step, limit, pause reason, an event line) and `session_end`; the app sends `loop_stop`. No message lets the extension change the mode, the allowlist or any setting.

**The app is the authority.**

- `ModeState` (desktop `policy.ts`) holds the mode. `settings.json` saves `manual` or `auto-apply` only; turning on Full auto saves `manual`, so a restart comes back in Manual. Full auto also drops to Manual on End session (`session_end`), unpairing (either side, or a new pairing replacing the old one) and switching project, and whatever is running is cancelled. Auto-apply survives all of these.
- Turning on Full auto shows a native dialog from main (the renderer can't skip it) that says the automation may break the chat provider's terms and risk the account, that commands run code the model may have written, and that it's opt-in and at the user's own risk.
- The server refuses `write` with `trigger: 'auto'` in Manual (`mode`) and on gated files in any mode (`gated`), before the sandbox. It refuses `run` with `trigger: 'auto'` outside Full auto (`mode`), and any command not on the allowlist even on a click (`not-allowlisted`). `trigger` is the extension's word; nothing proves a click was real. What it guarantees is that Bridge's own automation can't write or run more than the mode allows, and that nothing runs that the user didn't allowlist.

**Gated files** (`DEFAULT_GATED_FILES` in `policy.ts`, plus the user's patterns): `package.json`, lockfiles, `.npmrc`, `.yarnrc*`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, `.github/workflows/`, `.husky/`, `.githooks/`, `lefthook.yml`, `.pre-commit-config.yaml`, `Dockerfile`, `Makefile`. Honest limits: this blocks only the most direct ways of changing what an allowlisted command does. Running the tests still runs test files the chat wrote, and config files that are code (`vitest.config.ts`, `eslint.config.js`, `jest.config.js`, a `conftest.py`) can do anything a script can. Add those patterns if you want them gated too; the real boundary is that Full auto runs code from the model with your permissions.

**Auto-apply.** When a reply that wasn't on the page at load finishes, its edits are applied in order with `trigger: 'auto'`. Held for a click: `suspectedPartial`, `conflict` (the card re-reads and shows the new diff), `blocked`, gated (the app refuses; the card says so), and over 1 MB. Replies already on the page when it loads are never acted on. Cards record `auto: true` and say "Auto-applied". **Undo all** (message bar, two or more applied) undoes newest first and stops at the first failure. The app shows a toast and labels those Activity rows "auto".

**Command parsing.** `parseCommand` (shared) uses shell-quote's tokenizer, after refusing `$`, backticks, newlines, control characters and glob characters (`* ? [ ]`) in the raw text, then any operator, glob or comment token, a leading `NAME=value`, and more than 1,000 characters or 100 words. Quotes group words; quoted shell characters are just characters (there's no shell). The extension parses `@@RUN` text to argv; the desktop re-checks every word with `checkArgv` (the same per-word rules) and matches the allowlist itself.

**Allowlist.** Per project (by `projectId`), in `settings.json`, edited only in the app. An entry is a program plus an argument prefix, matched word for word, so `pnpm test` allows `pnpm test -- --run` but not `pnpm testx`. Extra arguments are passed through: some programs can do more than expected with them (`git diff --output=<file>` writes a file), which is why the defaults stick to scripts and read-only git. On first open the app suggests `package.json` check scripts with the project's package manager (from `packageManager` or the lockfile) plus `git status` and `git diff`; nothing is allowed until the user confirms.

**Spawning** (`commands/`):

- `resolveExecutable` finds a bare name on the PATH (skipping relative PATH entries) and refuses it if it resolves inside the project (`project-binary`), so `node_modules/.bin` on the PATH can't swap in a file the chat wrote. A path (`./scripts/check.sh`) is reachable only when the allowlist names that exact path; relative paths must stay inside the project.
- `spawn(file, args, { shell: false, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })`, POSIX children in their own process group (`detached`). Timeout (default 120s, 5s–10 min) and Cancel send SIGTERM to the group, then SIGKILL after 2s; on Windows `taskkill /pid N /T /F`. When the command exits on its own, whatever it left in its group is killed too, and stdio gets 1s to drain.
- **Windows:** Node refuses to spawn `.cmd`/`.bat` files without a shell, and package managers install as `.cmd` shims (`pnpm.cmd`, `npm.cmd`). `cross-spawn` handles exactly this: it wraps the shim in `cmd.exe /d /s /c "…"` with every argument escaped for cmd's rules (and twice for `node_modules\.bin` shims). It's used only when `process.platform === 'win32'`; elsewhere it's Node's `spawn`. cross-spawn only double-escapes for `node_modules\.bin`, and a global shim's `%*` lets cmd re-read arguments (the "BatBadBut" class of bug), so Bridge also refuses any argument containing `" % ! ^ & | < > ( )` or a line break when the target is a batch file. `runner.test.ts` pins cross-spawn's escaping on every platform and round-trips arguments through a real `.cmd` shim on the Windows CI job.
- **Environment:** the user's, minus `*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `AWS_*`, `OPENAI_*`, `GITHUB_TOKEN`, `NPM_TOKEN`, `ELECTRON_RUN_AS_NODE` (case-insensitive) and the user's own patterns, plus `CI=1` and `FORCE_COLOR=0`. Users can add patterns but not remove the defaults. Variables the launching package manager adds (lowercase `npm_*`, `INIT_CWD`, `PNPM_SCRIPT_SRC_DIR`, present when Bridge runs under `pnpm dev`) are dropped too: npm warns about every `npm_config_*` it doesn't know, which filled the chat's output budget.
- **Output:** one run at a time. ANSI codes stripped, line breaks normalised. The first and last 100 KB are kept (200 KB) with a note where the middle was cut. Live output streams to the app, the side panel and the card in ~100ms batches until the first 100 KB; the result carries the rest. The chat gets a head+tail cut of about 8,000 characters marked `[truncated]` (`formatRunResult`).

**RUN cards** (one per `@@RUN`, after the READ card): badge `allowlisted`, `not allowed`, `running`, `exit 0`, `exit N`, `timed out`, `cancelled` (or `failed` if it couldn't start). **Run** only for allowlisted commands, **Cancel** while running, live output capped like the diff view, **Send output** inserts without submitting. A command that isn't allowed says to add it in the app; the card has no way to.

**Full auto loop** (`FullAutoLoop` in the content script, a state machine over injected page, clock and reply actions):

- `idle → acting → sending → waiting-reply → acting …`, plus `paused` and `stopped`. A run starts on a new reply with actions; each step applies edits (Auto-apply rules), reads files and runs commands in order, builds one follow-up (`buildFollowUp`: summary, `@@CONTEXT` files, command results), inserts it, clicks the page's send button, and waits up to 10s for the send to land: a new user turn, or the composer no longer holding the message (the live page unmounts far-off turns, so the count alone can stay flat). A reply that arrives during that wait, or after a "send failed" pause, also counts as proof, and the run goes on.
- It ends on a reply with no actions or with `@@DONE@@` (edits in a DONE reply are still applied).
- It pauses on: gated, partial, conflicting or blocked edits; a command that isn't allowed; a non-zero exit only with "Pause on failure" (off by default); a follow-up over 30,000 characters after trimming output to 2,000 characters each and then dropping file contents; an error or limit banner (`SELECTORS.errorBanner` plus `ERROR_TEXT`); a lost connection; navigating to another conversation; the step limit; a send that never shows up. Resume carries on from where it stopped (and won't re-insert text that's still in the composer). After inserting, it waits up to 5s for the send button: the live page shows or enables it only once it has rendered the text. Closing or reloading the tab ends the run: the worker reports it stopped and cancels its command.
- Step limit 10 by default (1–25), counted in auto-sent messages. At the limit: **Continue for N more** (N = the configured limit).
- At least 3s between auto-sends, and no other delay: no random waits meant to look human.
- **Stop** (side panel, app, page chip) cancels the running command and halts the loop at once. It reverts nothing. It's sticky: no run starts again until the user allows it. Turning Full auto off in the app ends a run the same way.
- Every state change goes to the app as a `loop_report`; events become Activity rows grouped under their run, next to that run's writes and commands (which carry its `loopId`).

**Pairing key, fonts, READ cards**: see "Phase 4 follow-ups".

Open points carried forward:

- The send button, user-turn and error-banner selectors are best guesses from the page as of October 2026, checked only against the e2e stand-in. Check them on the live site (manual test script in `e2e/README.md`).
- ~~An Electron app started from the macOS Dock doesn't get the shell's PATH.~~ Fixed at the start of Phase 6 (see "Phase 6 decisions").
- The Windows-only tests (the `.cmd` round-trip in `runner.test.ts`, batch-argument refusal in `service.test.ts`) skip on macOS and Linux and haven't run yet; they run on the Windows CI job.

## Phase 6 decisions

App UI polish, delete and rename, files in context, the file watcher, and edge cases.

### Login shell PATH (Step 0)

An app opened from the Dock or a desktop launcher gets only the system PATH, so `pnpm` from nvm, Volta or Homebrew is "not found". Code: desktop `src/main/commands/login-env.ts`.

- At startup on macOS and Linux, main runs `$SHELL -ilc '<marker>; env; <marker>'` **once** (`loginEnvOnce`), with no stdin, in its own process group, and kills the group after 5s or 1 MB of output. The script is a constant; the random marker reaches it through the environment (`BRIDGE_ENV_MARKER`), so nothing is spliced into shell text. Only the lines between the two marker lines count, so whatever `.zshrc` prints is ignored. Only `PATH` is taken from it; the rest of the command environment is still the app's own, filtered as before.
- `$SHELL` must be absolute (falling back to the account's shell from `os.userInfo()`). If anything fails (no shell, timeout, no markers, a PATH with no absolute entry), commands get the app's own PATH and Settings shows why, with the PATH override as the fix.
- **PATH override** (Settings → Commands): replaces the PATH for commands. It must have at least one absolute entry and no control characters. Clearing it goes back to the login shell's. It doesn't change how executables are resolved: relative PATH entries are still skipped and programs inside the project are still refused.
- Windows apps get the full PATH from the system, so the shell isn't run there (`inherited`).
- The first command after launch waits for the read if it's still going.

## Modes

| Mode           | Edits                                                                                                  | Commands                                                                       | Sending                                 |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------- |
| **Manual**     | Pending diff cards. Nothing is written until you click Apply                                           | RUN cards. **Run** on a click; **Send output** puts the result in the composer | You press send                          |
| **Auto-apply** | Written when the reply finishes, in order, except held ones (below). Cards say Auto-applied, with Undo | As in Manual                                                                   | You press send                          |
| **Full auto**  | As in Auto-apply                                                                                       | Allowlisted commands run one after another                                     | Bridge clicks send, within a step limit |

Held for a click in every mode: suspected partial files, conflicts, files the sandbox refuses, files over 1 MB, and gated files. Every mode uses the same path sandbox and allowlist. Modes only change _when_ things happen, never _what_ is allowed.

## Security model

These rules don't change between phases. CLAUDE.md repeats them.

1. **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0` or `localhost`. It rejects any request whose `Host` isn't `127.0.0.1:<port>` (DNS rebinding), any whose `Origin` isn't the allowlisted extension, and any message without a valid session token. Messages are size-capped and rate-limited.
2. **Path sandbox.** Every path from the chat is untrusted:
   - Reject absolute paths, drive letters, NUL, empty segments and any `..` segment.
   - Resolve against the project root, then `realpath` the deepest existing ancestor and require it to stay inside the root's realpath. This blocks symlinks that point out.
   - Reject anything on the denylist (`.git/`, `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `node_modules/`, plus the user's own patterns), ignoring case.
   - Cap file size. Writes are atomic (temp file plus rename).
3. **Commands** use `spawn(file, args, { shell: false, cwd: root })` with an allowlist of `argv` prefixes the user sets in the app (e.g. `pnpm test`, `pnpm lint`, `git status`, `git diff`). There's no shell, no string concatenation, a timeout that kills the process tree, an output cap, and a filtered env. On Windows only, `.cmd`/`.bat` shims go through `cross-spawn`, which wraps them in `cmd.exe` with every argument escaped (see "Phase 5 decisions").
4. **Electron**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, and a strict CSP (`default-src 'none'`). Window opening and navigation are denied, and all permission requests are refused.
5. **Extension**: minimal permissions, chatgpt.com only, no remote code, and no `eval`. Injected UI lives in a shadow root.
6. **No telemetry**, no analytics, and no network calls except loopback.
7. **No OpenAI or Codex branding.** Bridge is its own product. Refer to "the chat" in UI copy.

## The chat format

Each edit is one whole file, a marker line (in inline code, so markdown leaves `__init__.py` alone) and one fenced block:

````
`@@FILE src/hooks/useTheme.js@@`
```js
...full file contents...
```
````

- The marker is on its own line, plain or in inline code, optionally as a list item. The path is everything between `@@FILE ` and the closing `@@`, and may contain spaces. It's relative to the project root.
- The fence follows the marker, with at most two blank lines between. The language tag is optional. Backticks or tildes work, 3 or more.
- The block ends at a line made only of the same fence character, at least as long as the opener. Wrap a file that itself contains a triple-backtick fence in four backticks.
- Content is the text between the fences, plus a trailing newline. CRLF is normalised to LF.
- A fence that never closes ends parsing. That's what you see mid-stream or in a truncated reply.
- Content with a placeholder comment (`// ...rest unchanged`, `# ... existing code`, `/* ... */`, "rest of the file") is flagged `suspectedPartial`. Only comment lines are checked, so `...rest` spreads and Python's `...` don't count.
- `` `@@READ path@@` `` (one per line, or several on one line) asks Bridge for a file. The READ card lists them.
- Files Bridge sends are `` `@@CONTEXT path@@` `` plus a fence longer than any backtick run in the file (`pickFence`). The parser skips them, so they're never edits.
- The parser does no path validation. That's the desktop sandbox's job.
- Not yet supported: deletes, renames and partial patches. Possible later syntax is `@@DELETE path@@`.

The "Start session" prompt (`buildSessionPrompt`) teaches the chat these rules: whole files only, no placeholders, one block per file, relative paths, ask with `@@READ` instead of guessing. It lists the project tree as an outline, about 1,500 entries at most; past that, the deepest folders are summarised as "(N more entries)".

## Phases

| #   | Phase                      | Goal                                                               | Deliverables                                                                                                                                                                                                                                                                                |
| --- | -------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Monorepo setup             | `pnpm install && pnpm dev` runs both apps, which share one package | Workspace, strict TS, lint, format, tests, CI. `@bridge/shared` with types and the parser (tested). Hardened Electron shell. MV3 extension stub. Design tokens and logo. Docs                                                                                                               |
| 2   | Local server and pairing   | The extension and desktop connect securely                         | WS server on 127.0.0.1 with Origin and token checks. Pairing-code flow. Protocol envelope and schemas in shared (zod). Background connection with reconnect. Status pill live in both UIs                                                                                                   |
| 3   | Project and files          | The extension can read and write inside one folder, with undo      | Folder picker and recents. Path sandbox with 40+ attack tests. `tree`, `read`, `write`, `undo` over the socket. Atomic writes with conflict checks. Backups and op log in userData. Activity list with undo. Dev-only test field                                                            |
| 4   | Chat integration           | Manual mode works end to end in the chat: read edits, send context | Start session prompt. Parser for FILE/READ/CONTEXT with partial detection. DOM adapter with fixtures. Diff cards in a shadow root with Apply, Reject, Undo, Apply all, conflict re-read. READ card. Composer insert. Send files with budget meter                                           |
| 5   | Modes, commands, Full auto | Close the loop, safely                                             | Mode switch owned by the app, mirrored in the extension and on the cards. Auto-apply with Undo and Undo all. Gated files. Allowlisted `spawn` runner with env filter, timeout, tree kill, output cap. RUN cards. Full auto loop with step limit, Stop, pause reasons, step counter and chip |
| 6   | App UI polish              | The app is pleasant to use daily                                   | Desktop UI pass. Carried over from the old Phase 5 and not started: files-in-context tree in the side panel, delete and rename (`@@DELETE path@@`)                                                                                                                                          |
| 7   | Security hardening         | Safe to use daily                                                  | Security review against this doc. E2E smoke tests. Electron kept on a supported major                                                                                                                                                                                                       |
| 8   | Packaging and release      | Installable without a dev setup                                    | electron-builder mac and win packages. Extension zip. Docs pass                                                                                                                                                                                                                             |
