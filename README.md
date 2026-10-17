# Bridge

<img src="packages/shared/assets/logo.svg" width="48" alt="" />

Bridge lets the ChatGPT web chat edit a project on your computer. The chat writes whole files in a simple `@@FILE` format. Bridge shows each one as a diff card right in the conversation and writes it to your project when you say so, or automatically with undo.

It runs entirely on your machine. The desktop app listens only on `127.0.0.1`, and nothing is sent anywhere else.

> **Status:** Phase 4 of 7 (chat integration, Manual mode) is done. Start a session from the side panel, and every whole-file edit the chat writes shows up as a diff card with Apply, Reject and Undo. You can send files to the chat, and send the ones it asks for, with a click. Nothing is sent or applied on its own. Auto-apply and commands come next. See [CHECKLIST.md](CHECKLIST.md).

## How it works

```
chatgpt.com ──▶ Chrome extension ──WebSocket (127.0.0.1)──▶ Bridge desktop ──▶ your project
  @@FILE blocks   parses, shows diff cards                    sandboxed writes, undo,
                  side panel                                  allowlisted commands
```

1. **Start session** puts instructions and your file list into the chat's message box. You send it.
2. The chat replies with one or more blocks like:

   ````
   `@@FILE src/hooks/useTheme.js@@`
   ```js
   ...full file...
   ```
   ````

   or asks to see files with `` `@@READ src/app.ts@@` ``.

3. The extension parses finished replies with the shared parser and shows a diff card under each block, or a card listing the files it asked for.
4. You click **Apply**. The desktop app checks the path against the project sandbox and writes the file. Every write can be undone.
5. Three modes will control how much happens automatically: **Manual** (today), **Auto-apply** and **Full auto**.

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
4. Open https://chatgpt.com (reload any tab that was already open).
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

## Use it in the chat

You need the app running with a project open, the extension paired, and a chat open on chatgpt.com.

1. Open the side panel next to the chat tab. Under **Session** it shows how big the instructions are (your file list included), then click **Start session**. The text lands in the message box; read it and press send. In a new chat, the session attaches to the conversation once it gets its address after your first message. The panel then reads **Session active**.
2. Ask for a change. When the reply finishes, each `@@FILE` block gets a card under it with a diff against your file, `+N −M`, and a badge (`new`, `modified`, `unchanged`, `conflict`, `blocked`, `partial?`).
3. **Apply** writes the file, **Reject** dismisses the card, and **Undo** (after applying) puts the old file back. A reply with two or more files has **Apply all**, which stops at the first problem. A block that looks partial (`// ...rest unchanged`) needs a second click.
4. If you edited the file after the card appeared, Apply reports a conflict and shows the new diff. Check it and click Apply again.
5. If the chat asks for files (`@@READ`), its card lists them and their size. **Send these files** puts them in the message box. To send files yourself, tick them under **Send files** in the side panel and click **Insert**. Both warn above 30,000 characters, where the chat may turn the text into an attachment or cut it.
6. **End session** stops Bridge reading that conversation. Its cards stay but are disabled.

Card states survive a page reload. Writes from cards show in the app's **Activity** as "via chat".

If the side panel says **Bridge can't read this page layout**, the chat page changed in a way Bridge doesn't recognise. Nothing is parsed until the selectors are updated (see `apps/extension/src/content/chat/selectors.ts`).

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
    src/content/    runs on chatgpt.com: chat/ reads messages, injects cards, fills the composer
    fixtures/       saved chat page markup for the adapter tests
    src/background/ service worker
    src/sidepanel/  React side panel
packages/
  shared/           @bridge/shared: types, chat parser and prompts, diff helper, protocol schemas, logo, design tokens
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
| `pnpm test`         | Vitest (shared, desktop, extension incl. happy-dom) |
| `pnpm package:mac`  | Build a macOS dmg/zip with electron-builder         |
| `pnpm package:win`  | Build a Windows installer with electron-builder     |

Manual end-to-end scripts (Playwright, not in CI) live in [`e2e/`](e2e/README.md).

## Troubleshooting

- **`Cannot read properties of undefined (reading 'whenReady')` on `pnpm dev`**: your shell has `ELECTRON_RUN_AS_NODE=1` set. Some editor-integrated tools set it, so Electron starts as plain Node. Run `unset ELECTRON_RUN_AS_NODE` first.
- **"That folder holds Bridge's own data"**: you picked Bridge's userData folder, or a folder containing it. Choose the project folder itself.
- **Desktop says "Server error"**: something else is using every port from 47821 to 47830. Free one and restart Bridge.
- **No cards in the chat**: check the side panel says **Session active** for this tab. Cards only appear once a reply has finished. If the chat tab was open before the extension was loaded or reloaded, reload the tab.
- **Cards use the system font**: chatgpt.com's content security policy blocked the extension's fonts. Cards still work.
- **Side panel stays on "Can't reach Bridge"**: the app answered but the handshake failed. If you unpaired in the app while Chrome was closed, click **Unpair** in the side panel and pair again. Otherwise the extension ID may not match: check that the extension was loaded from `apps/extension/dist` and that the ID on `chrome://extensions` is the one above.

## Docs

- [PLAN.md](PLAN.md): architecture, modes, security model, phases
- [CHECKLIST.md](CHECKLIST.md): task-level progress
- [DESIGN.md](DESIGN.md): design tokens and component specs
- [CLAUDE.md](CLAUDE.md): working rules for AI coding sessions
