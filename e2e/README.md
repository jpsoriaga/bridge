# End-to-end scripts

Playwright scripts that drive the **built** desktop app and a headless Chrome for Testing with the unpacked extension. They are not part of the pnpm workspace. CI runs them on Linux under `xvfb-run` (the `e2e` job in `.github/workflows/ci.yml`).

## Setup

```bash
pnpm build                                  # apps/desktop/out and apps/extension/dist
npm install --prefix e2e                    # playwright-core only, outside the workspace
npx --prefix e2e playwright-core install chromium
```

Set `CHROMIUM_PATH` to use a different Chromium binary. Each run uses fresh temp directories for the app's userData and the Chrome profile, so it never touches your real pairing.

The scripts run alongside `pnpm dev` without meeting it: they launch the app with `BRIDGE_E2E=1`, which makes a dev (unpackaged) build listen on 47921–47930 (`E2E_PORT` in `packages/shared/src/ports.ts`), and build their own copy of the extension for that range into a temp folder (`buildExtension` in `lib.cjs`). The extension in `apps/extension/dist` and packaged apps always use 47821–47830.

If your shell sets `ELECTRON_RUN_AS_NODE=1`, the scripts unset it for the app they launch.

## Scripts

| Command                  | What it checks                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node e2e/run.cjs .`     | Wrong then right pairing code, `tokenHash`-only storage, encrypted `pairing.json`, unpair from either side, app quit and relaunch (alarm set, then cleared), 5-wrong-code lockout                                                                                                                                                                                                                                 |
| `node e2e/probe.cjs .`   | Which loopback calls the worker can make with and without `host_permissions` (the Phase 2 decision in PLAN.md)                                                                                                                                                                                                                                                                                                    |
| `node e2e/project.cjs .` | Phase 3: tree, read, write, undo and sandbox refusals through a dev build                                                                                                                                                                                                                                                                                                                                         |
| `node e2e/chat.cjs .`    | Phases 4–5 against a stand-in chatgpt.com served from the fixtures: allowlist confirmed in the app, start session (prompt lists the allowlist), card fonts on dynamic URLs, Apply/Undo, Apply all, READ card, conflict, reload, regenerate, Auto-apply with a gated file and Undo all, a 2-step Full auto run to `@@DONE@@` (3s gap checked), End session back to Manual. `E2E_SCREENSHOTS=dir` saves screenshots |

| `node e2e/phase6.cjs .` | Phase 6 on the same stand-in page: the first-run checklist ticking itself off, the session prompt teaching DELETE/RENAME, delete and a case-only rename that Auto-apply leaves alone, a click and Undo for each, the Activity filter and diff, a file in context going stale and Resend changed, a second tab with Move here, and the extension reloading under the page |
| `node e2e/sessions.cjs .` | Sessions across client-side navigation: chat A, then New chat and Start session at once (prompt inserted, binds when the chat gets its id), back to A (ended), then another chat and Start again |
| `node e2e/stale.cjs .` | Stale files through the side panel's UI: a file sent to the chat, edited on disk, marked `changed`; **Resend changed** inserts the new content and the mark clears |
| `node e2e/screenshots.cjs .` | Saves the README screenshots (app pages, cards, side panel; light and dark) to `docs/screenshots/` |

`chat-lib.cjs` holds the stand-in page and the card helpers both chat scripts use.

The argument is the repo root. Each script prints one line per step and ends with `E2E OK` or exits non-zero.

Ports 47921–47930 must be free while a script runs (only another e2e run uses them).

## Manual check on the real chatgpt.com

`chat.cjs` serves a copy of the page, because chatgpt.com needs a login. Before calling a chat change done, run this by hand in your own Chrome with `pnpm build`, the extension loaded from `apps/extension/dist`, the app running with a scratch project open, and the extension paired:

1. Open a new chat. In the side panel, check the size line, click **Start session**, and send the prompt. The panel shows **Session active** with the conversation id once the URL is `/c/<id>`.
2. Ask for an edit to one file. When the reply finishes, a card appears under the code block. **Apply**: the file changes and the app's Activity says "via chat". **Undo**: it's back.
3. Ask for a change to two files. **Apply all** applies both in order.
4. Ask it to look at a file before editing. The READ card lists it; **Send these files** fills the message box (not sent).
5. Let the chat propose an edit, change that file in your editor, then **Apply**: the card shows `conflict` and the new diff. Apply again.
6. Reload the page: cards come back as Applied / Rejected / Undone.
7. Regenerate a reply: the new reply gets fresh cards.
8. **End session**: the cards stay but are disabled.

Also check the DevTools console for "[Bridge] Font blocked by the page" (CSP) and the side panel for the layout notice.

### Phase 5 on the real chatgpt.com

Use a scratch project with a `package.json` that has a `test` script and one failing test (for example, a function returning the wrong value and a test for it). Open it in the app, confirm the suggested commands under **Commands**, pair, and start a session in a new chat.

1. **Manual: run a command and send its output.** Ask the chat to run the tests. A RUN card appears with `allowlisted`. Click **Run**: output streams on the card, in the side panel and in the app; the badge ends at `exit 1`. **Send output** puts it in the message box without sending. Send it yourself.
2. **Auto-apply, then Undo all.** Switch the app to **Auto-apply** (the side panel and the cards' mode tag follow). Ask for a change to two files. When the reply finishes, both cards say **Auto-applied**, the app shows a toast and "· auto" rows. Click **Undo all (2)** under the cards: both files go back.
3. **Gated file.** Ask the chat to add a dependency to `package.json`. In Auto-apply the card stays pending with "needs your click in every mode"; the app's Activity says "Left for a click · gated file". **Apply** on the card writes it.
4. **Full auto fixes a failing test.** Switch to **Full auto**; confirm the dialog. Ask the chat to make the tests pass, running `@@RUN <your test command>@@` after each change and ending with `@@DONE@@`. Watch it apply, run, send the output and continue on its own, at least 3 seconds between sends, until a reply says `@@DONE@@`. The chip on the page and the panel count `N / 10`; the app's Activity groups the run.
5. **Step limit.** In the app set the step limit to 2 and repeat with a task that takes more steps. At `2 / 2` it pauses; the panel offers **Continue for 2 more**.
6. **Stop during `pnpm test`.** Start another Full auto run with a slow test command (or add `sleep` to a test). While it runs, press **Stop** on the page chip (then try the panel's and the app's on another run). The command is cancelled (badge `cancelled`), nothing more is sent, nothing is reverted, and the panel offers **Allow Full auto again**.
7. **A command that isn't allowed.** Ask the chat to run something not on the list (`git push`, or `pnpm test | tee out`). The RUN card says `not allowed` and "Add it to the allowlist in the Bridge app", with no Run button. In Full auto the loop pauses with "isn’t on the allowlist"; **Resume** sends the follow-up saying it wasn't run.

Also check: **End session** turns the app back to Manual; the send button, user-turn count and any error banner are found (if Full auto pauses with "no new message appeared" after a real send, `SELECTORS.sendButton` / `userMessage` need updating); the DevTools console has no "[Bridge] Font blocked" note.

### Phase 6 on the real chatgpt.com

Start from a fresh userData so the checklist shows: quit Bridge, then launch it with a scratch folder, e.g. `env -u ELECTRON_RUN_AS_NODE pnpm --filter @bridge/desktop exec electron . --user-data-dir=/tmp/bridge-fresh` (or move `~/Library/Application Support/@bridge/desktop` aside and restore it after). Use a scratch project with a few files, one named `App.tsx`.

1. **Onboarding from a fresh userData.** The Session page shows **Get started, 0 of 4 done**. Pair the extension (it ticks), open the project (⌘O; it ticks), confirm commands (the step's button jumps to Settings → Commands; it ticks), then start a session on chatgpt.com from the side panel and send the prompt (the last step ticks: **You’re set up**). Close it; **Help → Getting started** brings it back.
2. **Delete and rename with undo.** Switch to **Auto-apply**. Ask the chat to delete one file and rename `App.tsx` to `app.tsx` using the markers. A red DELETE card (with the size) and a RENAME card (`App.tsx → app.tsx`) appear and stay pending: nothing changes on disk. **Delete file**: gone; the app's Activity shows "Deleted · via chat". **Undo** on the card: it's back. **Rename**: Finder shows `app.tsx`. **Undo**: `App.tsx` again. In Activity, filter **Deletes** and open the row: the diff shows the whole file removed. Try Full auto with another delete: the loop pauses with "The reply deletes or renames files…" until you click, then **Resume**.
3. **Stale files.** In the side panel, **Send files** one file and press send. **Files in context** lists it with its size. Edit it in your editor and save: within a second or two it's marked `changed`. **Resend changed** puts the new version in the message box and the mark clears. Ask the chat to edit that file and Apply: it stays fresh.
4. **Multiple tabs.** Open the same conversation in a second tab. It shows "This chat’s Bridge session is active in another tab." with **Move here**, and no cards. Click **Move here**: this tab gets the cards, the first tab shows the notice. Close the second tab and reload the first: it takes the session back.
5. **Reload the extension mid-session.** On `chrome://extensions`, click reload on Bridge. Within a second, the chat tab drops every card and the chip and shows "Bridge was updated or reloaded. Reload the page to use it here." with **Reload**. After reloading, the cards come back as they were.
6. **Launch from the Dock.** Quit Bridge, then open it from the Dock or Finder (not a terminal; build and run the packaged app, or the dev `Electron.app`). In Settings → Commands, **PATH for commands** says "From your login shell" and lists your nvm/Volta/Homebrew folders. Run an allowlisted `pnpm` command from a RUN card: it runs. Launch Bridge again from the Dock: the existing window comes to the front (single instance), at the size and place you left it.
7. **Sleep and wake.** Start a Full auto run with a slow command (`sleep 30` in a test). While it runs, sleep the Mac for a couple of minutes, then wake it. The panel and app reconnect within a few seconds (no "Can't reach Bridge"), and the loop shows **Paused · after sleep** if it was mid-step. Check the cards, then **Resume**. Separately, with the app quit, sleep and wake: when you start the app the extension connects within seconds.

Also check: the page chip can be dragged to another corner and stays there after a reload; deleting the conversation from the sidebar ends its session; moving the project folder in Finder makes the app say **Project missing** (moving it back clears it); the desktop app in **Settings → Appearance → Dark** and the side panel in a dark system theme read clearly.

### Phase 7 on the real chatgpt.com

Start from a fresh userData (as for Phase 6), with a scratch project that has a `package.json` with a `test` script, and the extension reloaded from a new `pnpm build`.

1. **Pairing with the fingerprint.** In the app, **Pair extension**; type the code in the side panel and click **Pair**. Both show the same fingerprint (`a1b2 c3d4`). Click **They match** in the side panel first: it says to confirm in the app. Click **They match** in the app, then in the side panel: both say **Connected**. Pair again and click **Cancel** on both instead: nothing changes.
2. **Start session in a new chat after a session.** Start a session in a chat and send the prompt. Click **New chat** in the page's sidebar. The side panel shows **No session**; **Start session** puts the prompt in the message box straight away. Go back to the first chat: its session is **ended**.
3. **Auto-apply across sessions.** Switch the app to **Auto-apply**, end the session and start a new one: still Auto-apply. Switch to **Full auto**, then start a session: the app toasts "Full auto turned off: it’s per session." and the side panel's Mode section says the same.
4. **Result rows.** Let the chat create one file, modify one, rename one and delete one, and apply them. Created is green with `+`; Modified (pencil) and Renamed (arrow) are neutral; Deleted is red with a trash icon and the path struck through. No check icons. The app's Activity list matches.
5. **The chip as a dot.** In Manual or Auto-apply the chip in the corner is just a dot; hover it (or Tab to it) to see the mode. In Full auto it shows the counter and Stop. Make the window narrow and short, and open something that puts a banner over the message box: the chip moves up clear of both.
6. **Redaction.** Add a test that prints a fake key, e.g. `console.log('API_KEY=' + 'Q7f2Kp9xZ3mW8vR1tY6uN4bL0cJ5hG2d')`. Run it from a RUN card and **Send output**: the message box shows `API_KEY=[redacted]`, and the card says one likely secret was replaced.
7. **An allowlisted command with an extra argument.** With `pnpm test` (no `*`) on the allowlist, ask the chat to run `pnpm test --watch`. The RUN card says **not allowed**. Ask for `node -e "1"` with `node *` allowed: refused, naming `-e`.
