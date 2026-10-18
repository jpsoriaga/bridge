# Bridge

<img src="packages/shared/assets/logo.svg" width="48" alt="" />

Bridge lets the ChatGPT web chat edit a project on your computer. The chat writes whole files in a simple `@@FILE` format. Bridge shows each one as a diff card right in the conversation and writes it to your project when you say so, or automatically with undo.

It runs entirely on your machine. The desktop app listens only on `127.0.0.1`, and nothing is sent anywhere else.

> **Status:** Phase 6 of 8 (app polish, delete and rename, files in context, edge cases) is done. Edits show as diff cards with Apply, Reject and Undo; deletes and renames get their own cards and always need a click; Auto-apply writes edits for you with undo; commands on your allowlist run from RUN cards; and the opt-in Full auto mode can carry a task across several messages on its own, within a step limit. Security hardening is next. See [CHECKLIST.md](CHECKLIST.md).

| Light                                                                                                   | Dark                                                                          |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ![The Bridge app's Session page, light](docs/screenshots/app-session-light.png)                         | ![The Bridge app's Session page, dark](docs/screenshots/app-session-dark.png) |
| ![Cards in the chat: a diff, a delete, a rename and a command, light](docs/screenshots/cards-light.png) | ![The same cards, dark](docs/screenshots/cards-dark.png)                      |

More in [`docs/screenshots/`](docs/screenshots): the Activity and Settings pages and the side panel, both themes. `node e2e/screenshots.cjs .` regenerates them.

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

   or asks to see files with `` `@@READ src/app.ts@@` ``, or to delete or move one with `` `@@DELETE src/old.ts@@` `` and `` `@@RENAME src/a.ts -> src/b.ts@@` ``.

3. The extension parses finished replies with the shared parser and shows a diff card under each block, or a card listing the files it asked for.
4. You click **Apply**. The desktop app checks the path against the project sandbox and writes the file. Every write can be undone.
5. The chat can also ask to run a command with `` `@@RUN pnpm test@@` ``. Only commands on the allowlist you set in the app ever run.
6. Three modes control how much happens on its own: **Manual**, **Auto-apply** and **Full auto** (see [Modes](#modes)).

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

1. In the Bridge app, click **Open folder…** (⌘O) and choose your project. Bridge reopens it next time. The project switcher in the top bar lists your last 5.
2. The project name shows in the app's top bar, and its path on the **Session** page and in the side panel.

If the folder disappears while it's open (deleted, moved, renamed, or its disk unmounted), the app says **Project missing** and every request fails cleanly until it's back; **Try again** or **Open folder…** fixes it.

The first time you open the app, a **Get started** checklist on the Session page ticks itself off as you pair, open a project, confirm commands and start a session. Close it when you're done; **Help → Getting started** brings it back.

The extension can reach only files inside that folder. Bridge refuses absolute paths, `..`, and symlinks that lead outside it, and never touches `.git/`, `.env` and `.env.*`, `*.pem`, `*.key`, `id_rsa*` or `node_modules/`. Add your own patterns under **Settings → Protected files**. Blocked requests show in **Activity** with a red dot.

Every write, delete and rename is backed up first, into Bridge's own data folder (never into your project). The **Activity** page lists them: filter by kind (writes, deletes, renames, commands, blocked, automatic), search by path, and click a row to see its diff (or a command's full output) and **Undo** it. **Undo last** reverts the newest change. If you edited the file after Bridge changed it, Bridge asks before overwriting your edit. Backups are kept for 7 days (change it under **Settings → Backups**, 1–90) or 500 changes per project. **Settings → Backups** can also open the backups folder or clear it for the project.

Bridge reads and writes UTF-8 text only. Files in another encoding are refused (`not UTF-8`) rather than corrupted, a byte order mark is kept, and a file that ends without a newline keeps ending without one.

### Try it by hand (dev builds)

With `pnpm dev` running, the side panel has a **Test read (dev only)** field once connected: pick `tree`, `read`, `write` or `undo`, enter a path (or an op id for undo) and click **Send**. A write after a read of the same path modifies that file; a write without one creates a new file. Production builds don't include this field.

## Use it in the chat

You need the app running with a project open, the extension paired, and a chat open on chatgpt.com.

1. Open the side panel next to the chat tab. Under **Session** it shows how big the instructions are (your file list included), then click **Start session**. The text lands in the message box; read it and press send. In a new chat, the session attaches to the conversation once it gets its address after your first message. The panel then reads **Session active**.
2. Ask for a change. When the reply finishes, each `@@FILE` block gets a card under it with a diff against your file, `+N −M`, and a badge (`new`, `modified`, `unchanged`, `conflict`, `blocked`, `partial?`).
3. **Apply** writes the file, **Reject** dismisses the card, and **Undo** (after applying) puts the old file back. A reply with two or more files has **Apply all**, which stops at the first problem. A block that looks partial (`// ...rest unchanged`) needs a second click.
4. If the file changes on disk after the card appeared, the card notices (the app watches the project) and shows `conflict` with the new diff before you click. Apply then writes over what's there now. If the same reply edits a file twice, both cards show with a warning and **Apply all** uses the last one. An edit that changes nothing says `unchanged`; binary or over-1 MB content is refused on the card.
5. **Deletes and renames** get their own cards: a red DELETE card with the file's size, and a RENAME card with `old → new`. They only ever happen on a click (**Delete file**, **Rename**), in every mode, and **Undo** puts the file back. A rename onto a file that already exists is refused; a case-only rename (`App.tsx` → `app.tsx`) works on macOS.
6. If the chat asks for files (`@@READ`), its card lists them and their size. **Send these files** puts them in the message box. To send files yourself, tick them under **Send files** in the side panel and click **Insert** (the tree loads one folder at a time, so big repos stay quick). Both warn above 30,000 characters, where the chat may turn the text into an attachment or cut it.
7. **Files in context** in the side panel lists what you've sent this session and how much of the message each took. A file that changed on disk since is marked `changed`; **Resend changed** sends the new versions. Files the chat itself edited, deleted or renamed follow along instead.
8. **End session** stops Bridge reading that conversation. Its cards stay but are disabled.

Card states survive a page reload, and come back when a long conversation scrolls old messages out and back in. Changes from cards show in the app's **Activity** as "via chat". Every card has **Copy path**, collapses to one line, and shows when it was applied.

A session belongs to one tab. Another tab on the same conversation says **Session active in another tab**, with **Move here**. If you reload or update the extension while a chat is open, the page drops Bridge's cards and asks you to reload it. The page chip (mode, and the step count and **Stop** in Full auto) can be dragged to any corner.

If the side panel says **Bridge can't read this page layout**, the chat page changed in a way Bridge doesn't recognise. Nothing is parsed until the selectors are updated (see `apps/extension/src/content/chat/selectors.ts`).

## Modes

You switch modes in the desktop app. The side panel and every card show the current one. The app enforces it: the extension can only ask.

| Mode           | Edits                                                                                                  | Commands                                                                  | Sending                           |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------- |
| **Manual**     | Diff cards; nothing is written until you click Apply                                                   | RUN cards; **Run** on a click, **Send output** puts the result in the box | You press send                    |
| **Auto-apply** | Written as soon as a reply finishes. Each card says **Auto-applied** with Undo; **Undo all** per reply | As in Manual                                                              | You press send                    |
| **Full auto**  | As in Auto-apply                                                                                       | Allowlisted commands run on their own                                     | Bridge sends the follow-up itself |

In every mode, Bridge leaves these for your click: deletes and renames, files that look partial, that changed on disk, that the sandbox refuses, that are over 1 MB, and **gated files**. Gated files can change what a command does: `package.json`, lockfiles, `.npmrc`, `.yarnrc*`, `pnpm-workspace.yaml`, `.github/workflows/`, `.husky/` and other hook folders, `Dockerfile`, `Makefile`. Add your own under **Settings → Gated files**. This only blocks the most direct routes: running the tests still runs test code the chat wrote.

Auto-apply is remembered. Full auto is not: it turns off when you restart Bridge, end the session, unpair or switch projects.

## Commands and the allowlist

The first time you open a project, **Settings → Commands** suggests commands from its `package.json` scripts (`pnpm test`, `pnpm lint`, …) plus `git status` and `git diff`. Tick the ones you want and click **Allow**. Nothing runs until you do. You can add and remove commands there at any time. Nothing in the chat or the extension can change the list.

- An entry is a program plus the start of its arguments: `pnpm test` also allows `pnpm test -- --run src/a.test.ts`, but not `pnpm testx`. Extra arguments are passed as they are, so allow only programs whose arguments you're comfortable with (some, like `git diff --output=<file>`, can write files).
- There is no shell. Pipes, `&&`, `;`, redirects, `$`, backticks, wildcards and `FOO=1 cmd` are refused, and so is anything longer than 1,000 characters.
- Programs are found on your `PATH`. One that resolves inside the project (say `node_modules/.bin` on your `PATH`) is refused; to run a project script, allowlist its exact path, like `./scripts/check.sh`.
- Commands run in the project folder with your environment, minus anything that looks like a secret (`*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `AWS_*`, `OPENAI_*`, …; add more under **Settings → Hidden from commands**), with `CI=1` and `FORCE_COLOR=0`.
- One command at a time. The timeout is 120 seconds by default (up to 10 minutes) and kills everything the command started. Output is kept up to 200 KB (start and end), and the chat gets about 8,000 characters of it.

Output streams live on the RUN card, in the side panel and in the app, where **Cancel** stops it.

## Full auto

> **Read this before turning it on.** Full auto clicks the chat's send button for you. Automating the chat this way may break its provider's terms of use and put your account at risk. The commands it runs execute code the model may have written (tests, build scripts), with your user's permissions. It's opt-in and at your own risk, and the app asks you to confirm every time you turn it on.

When a reply finishes, Bridge applies its edits, reads the files it asked for, runs its allowlisted commands one after another, and sends one follow-up message with the results. It checks that the message really appeared, then waits for the next reply. It ends when a reply asks for nothing or says `` `@@DONE@@` ``.

It pauses and waits for you on a delete or rename (those always need your click); a gated, partial, conflicting or blocked edit; a command that isn't allowed; a failed command if you turned on **Pause on failure** (off by default, so test failures go back to the chat to fix); a follow-up too big to send even trimmed; an error or limit banner on the page; a lost connection to the app; the app restarting (turn Full auto back on, then Resume); the computer sleeping in the middle of a step; or when you leave the conversation. Click **Resume** in the side panel to carry on.

- **Step limit:** 10 messages per run by default (up to 25, under **Settings → Full auto**). The panel and a chip on the page show `3 / 10`. At the limit it pauses and offers **Continue for 10 more**.
- **Pace:** at least 3 seconds between messages it sends, and no other delay.
- **Stop:** in the side panel, on the page chip, and in the app on every page while a run is going (also ⌘. or **Session → Stop Full auto**). It halts the loop and cancels the running command at once. It reverts nothing; every edit can still be undone.
- Every step shows in the app's **Activity**, grouped by run.

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

| Command             | What it does                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev`          | Desktop app with hot reload + extension watch build                                       |
| `pnpm build`        | Production build of both apps                                                             |
| `pnpm lint`         | ESLint over the whole repo                                                                |
| `pnpm format`       | Prettier write                                                                            |
| `pnpm format:check` | Prettier check (CI)                                                                       |
| `pnpm typecheck`    | `tsc --noEmit` in every package                                                           |
| `pnpm test`         | Vitest (shared, desktop, renderer with Testing Library and axe, extension with happy-dom) |
| `pnpm package:mac`  | Build a macOS dmg/zip with electron-builder                                               |
| `pnpm package:win`  | Build a Windows installer with electron-builder                                           |

Manual end-to-end scripts (Playwright, not in CI) live in [`e2e/`](e2e/README.md).

## Troubleshooting

- **`Cannot read properties of undefined (reading 'whenReady')` on `pnpm dev`**: your shell has `ELECTRON_RUN_AS_NODE=1` set. Some editor-integrated tools set it, so Electron starts as plain Node. Run `unset ELECTRON_RUN_AS_NODE` first.
- **"That folder holds Bridge's own data"**: you picked Bridge's userData folder, or a folder containing it. Choose the project folder itself.
- **Desktop says "Server error"**: something else is using every port from 47821 to 47830. Free one and restart Bridge.
- **No cards in the chat**: check the side panel says **Session active** for this tab. Cards only appear once a reply has finished. If the chat tab was open before the extension was loaded or reloaded, reload the tab.
- **"Project missing"**: the folder moved, was renamed or deleted, or its disk was unmounted. Put it back and click **Try again**, or open it from its new place.
- **"Reload the page to use it here"**: the extension was reloaded or updated while the chat was open. Reload the chat tab.
- **"Session active in another tab"**: another tab has this conversation's session. Click **Move here** to use this tab instead.
- **Cards use the system font**: chatgpt.com's content security policy blocked the extension's fonts. Cards still work.
- **A RUN card says "not allowed"**: the command isn't on the allowlist, or uses shell syntax. Add it under **Settings → Commands** if you want it.
- **"That program isn't installed or isn't on the PATH"**: on macOS and Linux the app reads your login shell's PATH once at startup, so it works when opened from the Dock too. If that failed, **Settings → Commands** says why; set **PATH for commands** there (paste the output of `echo $PATH`), or allowlist the program's full path.
- **Full auto paused with "no new message appeared"**: the chat page didn't take the send (its send button may have changed). Check the message box and press **Resume**.
- **Side panel stays on "Can't reach Bridge"**: the app answered but the handshake failed. If you unpaired in the app while Chrome was closed, click **Unpair** in the side panel and pair again. Otherwise the extension ID may not match: check that the extension was loaded from `apps/extension/dist` and that the ID on `chrome://extensions` is the one above.

## Docs

- [PLAN.md](PLAN.md): architecture, modes, security model, phases
- [CHECKLIST.md](CHECKLIST.md): task-level progress
- [DESIGN.md](DESIGN.md): design tokens and component specs
- [CLAUDE.md](CLAUDE.md): working rules for AI coding sessions
