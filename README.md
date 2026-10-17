# Bridge

<img src="packages/shared/assets/logo.svg" width="48" alt="" />

Bridge lets the ChatGPT web chat edit a project on your computer. The chat writes whole files in a simple `@@FILE` format. Bridge shows each one as a diff card right in the conversation and writes it to your project when you say so, or automatically with undo.

It runs entirely on your machine. The desktop app listens only on `127.0.0.1`, and nothing is sent anywhere else.

> **Status:** Phase 3 of 8 (project folder and sandboxed files) is done. The extension pairs with the desktop app and can list, read and write files inside the project folder you open, with every write backed up and undoable. It doesn't read the chat yet. See [CHECKLIST.md](CHECKLIST.md).

## How it works

```
chatgpt.com ──▶ Chrome extension ──WebSocket (127.0.0.1)──▶ Bridge desktop ──▶ your project
  @@FILE blocks   parses, shows diff cards                    sandboxed writes, undo,
                  side panel                                  allowlisted commands
```

1. The chat replies with one or more blocks like:

   ````
   @@FILE src/hooks/useTheme.js@@
   ```js
   ...full file...
   ```
   ````

2. The extension parses them with the shared parser and shows a diff card under the message.
3. The desktop app checks each path against the project sandbox and writes the file. Every write can be undone.
4. Three modes control how much happens automatically: **Manual**, **Auto-apply** and **Full auto**.

[PLAN.md](PLAN.md) has the full architecture and security model.

## Requirements

- Node.js 24 LTS (`nvm use` reads `.nvmrc`)
- pnpm 9.15.4 (`corepack enable` picks it up from `packageManager`)
- Google Chrome or another Chromium browser with side-panel support
- macOS, Windows or Linux

## Setup

```bash
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the Electron app (with hot reload) and rebuilds the extension into `apps/extension/dist` on every change.

## Load the extension

1. Run `pnpm dev` or `pnpm build` so that `apps/extension/dist` exists.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose **`apps/extension/dist`**.
4. Open https://chatgpt.com. The DevTools console shows `[Bridge] content script loaded`.
5. Click the Bridge toolbar icon to open the side panel.

The manifest carries a fixed `key`, so the unpacked extension always gets the ID `golkpkmancgpgkpfjggoimedcogghhip`. The desktop app only accepts connections from that ID.

During `pnpm dev`, the content script and side panel rebuild automatically. Click the reload icon on the extension's card in `chrome://extensions` and refresh the chatgpt.com tab to pick up changes.

## Pair the extension

You pair once. After that the extension reconnects on its own whenever both are running.

1. Start the Bridge desktop app. Its status reads **Not paired**, and Settings shows the local server address (normally `127.0.0.1:47821`).
2. Click **Pair extension**. The app shows a 6-digit code that works once and expires in 2 minutes.
3. Open the Bridge side panel in Chrome (the toolbar icon), type the code and click **Pair**.
4. Both status pills turn to **Connected**.

To unpair, click **Unpair** in either the app or the side panel. That revokes the pairing, and the other side shows **Not paired**. Pairing again from the app also replaces the old one.

After pairing, neither side sends the token again. They prove to each other that they hold its hash with an HMAC challenge, the app first, so a program pretending to be Bridge on one of its ports learns nothing. The extension remembers which port the real app was on and tries that one first.

After 5 wrong codes, pairing is locked for 60 seconds and the current code is cancelled. Start a new code once the lock ends.

If the side panel says **App not running**, open the desktop app. The extension keeps retrying (up to every 30 seconds, and at least once a minute even after Chrome suspends it) and retries immediately when you open the side panel.

## Open a project

1. In the Bridge app, click **Open folder…** and choose your project. Bridge reopens it next time, and lists your last 5 under **Recent**.
2. The project name and path show in the app's top bar and in the side panel.

The extension can reach only files inside that folder. Bridge refuses absolute paths, `..`, and symlinks that lead outside it, and never touches `.git/`, `.env` and `.env.*`, `*.pem`, `*.key`, `id_rsa*` or `node_modules/`. Add your own patterns under **Settings → Protected files**. Blocked requests show in **Activity** with a red dot.

Every write is backed up first, into Bridge's own data folder (never into your project). **Activity** lists each write with an **Undo** button, and **Undo last** reverts the newest one. If you edited the file after Bridge wrote it, Bridge asks before overwriting your edit. Backups are kept for 7 days or 500 writes per project.

### Try it by hand (dev builds)

With `pnpm dev` running, the side panel has a **Test read (dev only)** field once connected: pick `tree`, `read`, `write` or `undo`, enter a path (or an op id for undo) and click **Send**. A write after a read of the same path modifies that file; a write without one creates a new file. Production builds don't include this field.

## Project structure

```
apps/
  desktop/          Electron app (electron-vite)
    src/main/       main process: window, local server, pairing, project sandbox and backups
    src/preload/    contextBridge API (window.bridge)
    src/renderer/   React UI
    resources/      app icon, macOS entitlements
  extension/        Chrome MV3 extension (CRXJS + Vite)
    manifest.config.ts
    src/content/    runs on chatgpt.com
    src/background/ service worker
    src/sidepanel/  React side panel
packages/
  shared/           @bridge/shared: types, @@FILE parser, protocol schemas, logo, design tokens
archive/prototype/  earlier server/pairing prototype, kept for reference (not built)
```

## Scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Desktop app with hot reload + extension watch build |
| `pnpm build`        | Production build of both apps                       |
| `pnpm lint`         | ESLint over the whole repo                          |
| `pnpm format`       | Prettier write                                      |
| `pnpm format:check` | Prettier check (CI)                                 |
| `pnpm typecheck`    | `tsc --noEmit` in every package                     |
| `pnpm test`         | Vitest (parser, protocol, server, extension)        |
| `pnpm package:mac`  | Build a macOS dmg/zip with electron-builder         |
| `pnpm package:win`  | Build a Windows installer with electron-builder     |

Manual end-to-end scripts (Playwright, not in CI) live in [`e2e/`](e2e/README.md).

## Troubleshooting

- **`Cannot read properties of undefined (reading 'whenReady')` on `pnpm dev`**: your shell has `ELECTRON_RUN_AS_NODE=1` set. Some editor-integrated tools set it, so Electron starts as plain Node. Run `unset ELECTRON_RUN_AS_NODE` first.
- **"That folder holds Bridge's own data"**: you picked Bridge's userData folder, or a folder containing it. Choose the project folder itself.
- **Desktop says "Server error"**: something else is using every port from 47821 to 47830. Free one and restart Bridge.
- **Side panel stays on "Can't reach Bridge"**: the app answered but the handshake failed. If you unpaired in the app while Chrome was closed, click **Unpair** in the side panel and pair again. Otherwise the extension ID may not match: check that the extension was loaded from `apps/extension/dist` and that the ID on `chrome://extensions` is the one above.

## Docs

- [PLAN.md](PLAN.md): architecture, modes, security model, phases
- [CHECKLIST.md](CHECKLIST.md): task-level progress
- [DESIGN.md](DESIGN.md): design tokens and component specs
- [CLAUDE.md](CLAUDE.md): working rules for AI coding sessions
