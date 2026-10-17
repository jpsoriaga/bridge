# Bridge

<img src="packages/shared/assets/logo.svg" width="48" alt="" />

Bridge lets the ChatGPT web chat edit a project on your computer. The chat writes whole files in a simple `@@FILE` format. Bridge shows each one as a diff card right in the conversation and writes it to your project when you say so, or automatically with undo.

It runs entirely on your machine. The desktop app listens only on `127.0.0.1`, and nothing is sent anywhere else.

> **Status:** Phase 1 of 8 (monorepo setup) is done. The apps start and share code, but they don't talk to each other yet. See [CHECKLIST.md](CHECKLIST.md).

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

During `pnpm dev`, the content script and side panel rebuild automatically. Click the reload icon on the extension's card in `chrome://extensions` and refresh the chatgpt.com tab to pick up changes.

## Project structure

```
apps/
  desktop/          Electron app (electron-vite)
    src/main/       main process: window, security settings
    src/preload/    contextBridge API (window.bridge)
    src/renderer/   React UI
    resources/      app icon, macOS entitlements
  extension/        Chrome MV3 extension (CRXJS + Vite)
    manifest.config.ts
    src/content/    runs on chatgpt.com
    src/background/ service worker
    src/sidepanel/  React side panel
packages/
  shared/           @bridge/shared: types, @@FILE parser, logo, design tokens
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
| `pnpm test`         | Vitest (parser, window security, manifest)          |
| `pnpm package:mac`  | Build a macOS dmg/zip with electron-builder         |
| `pnpm package:win`  | Build a Windows installer with electron-builder     |

## Troubleshooting

- **`Cannot read properties of undefined (reading 'whenReady')` on `pnpm dev`**: your shell has `ELECTRON_RUN_AS_NODE=1` set. Some editor-integrated tools set it, so Electron starts as plain Node. Run `unset ELECTRON_RUN_AS_NODE` first.

## Docs

- [PLAN.md](PLAN.md): architecture, modes, security model, phases
- [CHECKLIST.md](CHECKLIST.md): task-level progress
- [DESIGN.md](DESIGN.md): design tokens and component specs
- [CLAUDE.md](CLAUDE.md): working rules for AI coding sessions
