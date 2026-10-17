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
- **Preload** exposes one typed object, `window.bridge`, through `contextBridge`. Every method maps to one narrow IPC channel whose inputs are validated in main. Phase 1 exposes only `version`.
- **Renderer** is React. It's the control surface: pick the project, pair, choose the mode, watch activity, stop. It never gets Node or Electron objects.

### Extension (`apps/extension`)

- **Content script** runs only on `https://chatgpt.com/*`.
  - Watches the conversation with a `MutationObserver`, and waits for an assistant message to finish streaming before parsing it with `parseFileBlocks`.
  - Injects diff and command cards under the message, inside a shadow root so page CSS can't leak in.
  - Writes text into the composer (for "Send files" and "Run & send output").
  - Holds no secrets.
- **Background service worker** owns the single connection to the desktop app. It relays messages between the content script, the side panel and the desktop, and reconnects with backoff.
- **Side panel** mirrors the desktop state: connection, project, mode, files in context, activity, step counter and Stop.
- **Permissions**: `storage` (the pairing token in `chrome.storage.local`) and `sidePanel`. The content script matches only chatgpt.com. There are no `host_permissions`.

### Shared (`packages/shared`)

Pure TypeScript with no Node or DOM dependencies (except `styles.css`):

- types (`FileEdit`, `Mode`, …)
- the `@@FILE` parser
- the protocol message types and schemas (Phase 2)
- the logo geometry
- the design tokens

It's consumed as TS source through `workspace:*`. Vite bundles it into every target. electron-vite needs `externalizeDepsPlugin({ exclude: ['@bridge/shared'] })` so main and preload bundle it rather than `require()` a `.ts` file. With that in place, no build step or tsup is needed.

### How they talk

| Link                        | Transport                                                                     | Auth                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Content script ↔ background | `chrome.runtime` messages                                                     | Chrome-internal                                                                                                                            |
| Side panel ↔ background     | `chrome.runtime` port                                                         | Chrome-internal                                                                                                                            |
| Background ↔ desktop        | WebSocket to `ws://127.0.0.1:<port>`, JSON envelopes `{v, id, type, payload}` | Server checks `Origin` is the extension's `chrome-extension://<id>` and requires the pairing token in the first message (never in the URL) |
| Renderer ↔ main             | Electron IPC via the preload API                                              | Process boundary; main validates every payload                                                                                             |

Pairing: the desktop shows a one-time code. You enter it in the side panel, which exchanges it for a long-lived token stored in `chrome.storage.local`. Revoking it in the desktop drops the socket. (To verify in Phase 2: a WebSocket from the extension to loopback needs no `host_permissions`. If it does, add exactly `http://127.0.0.1/*` and update this doc.)

## Modes

| Mode           | Edits                                                                   | Commands                                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manual**     | Shown as pending diff cards. Nothing is written until you click Apply.  | Shown as a command card. Runs only when you click "Run & send output".                                                                                                                                                                         |
| **Auto-apply** | Written as soon as the message finishes. The card shows Applied + Undo. | Same as Manual.                                                                                                                                                                                                                                |
| **Full auto**  | Written immediately, as in Auto-apply.                                  | Allowlisted commands run automatically, and their output is sent back as the next chat message. The loop continues until the chat stops proposing edits or commands, you press Stop, or the step limit (default 10, "Step N of M") is reached. |

Every mode uses the same path sandbox and allowlist. Modes only change _when_ things happen, never _what_ is allowed.

## Security model

These rules don't change between phases. CLAUDE.md repeats them.

1. **Loopback only.** The server binds `127.0.0.1`, never `0.0.0.0` or `localhost`. It rejects any request whose `Origin` isn't the paired extension, and any message without a valid session token. Messages are size-capped.
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
