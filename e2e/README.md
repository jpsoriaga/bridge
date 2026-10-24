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
| `node e2e/run.cjs .`     | Wrong then right pairing code, Copy in the app (digits only), pasting the code with a space, a dash or whitespace (paired at once; short pastes and Enter send nothing), 5-digit codes not counting toward the lockout, `tokenHash`-only storage, encrypted `pairing.json`, unpair from either side, app quit and relaunch (alarm set, then cleared), 5-wrong-code lockout                                        |
| `node e2e/probe.cjs .`   | Which loopback calls the worker can make with and without `host_permissions` (the Phase 2 decision in PLAN.md)                                                                                                                                                                                                                                                                                                    |
| `node e2e/project.cjs .` | Phase 3: tree, read, write, undo and sandbox refusals through a dev build                                                                                                                                                                                                                                                                                                                                         |
| `node e2e/chat.cjs .`    | Phases 4–5 against a stand-in chatgpt.com served from the fixtures: allowlist confirmed in the app, start session (prompt lists the allowlist), card fonts on dynamic URLs, Apply/Undo, Apply all, READ card, conflict, reload, regenerate, Auto-apply with a gated file and Undo all, a 2-step Full auto run to `@@DONE@@` (3s gap checked), End session back to Manual. `E2E_SCREENSHOTS=dir` saves screenshots |

| `node e2e/phase6.cjs .` | Phase 6 on the same stand-in page: the first-run checklist ticking itself off, the session prompt teaching DELETE/RENAME, delete and a case-only rename that Auto-apply leaves alone, a click and Undo for each, the Activity filter and diff, a file in context going stale and Resend changed, a second tab with Move here, and the extension reloading under the page |
| `node e2e/sessions.cjs .` | Sessions across client-side navigation: chat A, then New chat and Start session at once (prompt inserted, binds when the chat gets its id), back to A (ended), then another chat and Start again; then New chat as the real page does it, three times with End session between: the composer replaced, the old one kept but hidden, the URL `/` with no reload, and the prompt in the visible composer every time |
| `node e2e/stale.cjs .` | Stale files through the side panel's UI: a file sent to the chat, edited on disk, marked `changed`; **Resend changed** inserts the new content and the mark clears |
| `node e2e/format.cjs .` | Keeping the chat in the format (1.0.1): the session prompt (rules before the tree, no `.DS_Store` / `Thumbs.db` / `desktop.ini`), markers missing their closing `@@` getting cards marked `format fixed`, **Send output** ending with the format line, a format card whose **Send format reminder** inserts without sending, and Full auto sending two reminders then pausing with "format issues" |
| `node e2e/catchup.cjs .` | The install command and cut-off replies (1.1.0): `npm install` pre-ticked from a `package-lock.json` and allowed exactly, the install timeout and the catch-up toggle in Settings, the session prompt's install line, a reply cut off by a network error in Full auto (the whole file applied, the cut one not, the interrupted card, the continuation sent on its own), a second cut pausing with "reply cut off", and Resume sending the continuation |
| `node e2e/assets.cjs .` | 1.3.0: a background entry from Settings, the session prompt's dev server rule, START on a click (running at its URL in the card, the app and the side panel; its helper running), LOGS → Send logs, a second START restarting it, Save to project from `@@ASSET` and Undo, Send files → Attach and a READ card attaching an image (through the page's file input), Send files with a text file and a 3000×1500 transparent PNG (attached scaled to fit 2048px and 5 MB, still a PNG, the file on disk unchanged), an http download blocked and a 127.0.0.1 one refused, then Full auto with Unlimited and auto-approved deletes: requested files auto-sent (an image attached, `.env` refused), a breaking edit whose dev server error goes with the follow-up, the delete labelled auto-approved, the loop guard pausing "Looks stuck", a download pausing for a click, and End session stopping the dev server and its helper |
| `node e2e/send.cjs .` | 1.3.0 live-test fixes, round 2: a background command exiting 0 shown neutral on its card, in the side panel, the app and Activity, with **Start again**; in Full auto, `@@START` of a task run as a task (RUN card `format fixed`, **Run again**) whose long follow-up becomes a "Pasted text" chip that blocks send for 3s and is sent once it's ready; a send the page swallows pressed again and sent once; the side panel's background-tab tip (only where the browser really hides the tab: headless Chrome never does); a message-limit banner pausing with "Message limit reached; resets at 4:30 PM." on the page, in the app and the panel, then Resume; and closing the chat tab mid-run pausing with "The chat tab was closed or unloaded", ended by Stop in the app |
| `node e2e/screenshots.cjs .` | Saves the README screenshots (app pages, cards, side panel; light and dark) to `docs/screenshots/`, and the Chrome Web Store images to `store/`. Uses the real ports (Settings shows the port), so quit `pnpm dev` first |

`chat-lib.cjs` holds the stand-in page and the card helpers both chat scripts use, including `checkCardButtons`: `chat`, `phase6`, `format`, `catchup` and `assets` call it with their cards on the page, and it fails if any card action isn't a `card-btn` or isn't 32px tall.

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

### 1.0.1 on the real chatgpt.com

Build (`pnpm build`), reload the extension from `apps/extension/dist`, restart the app, and open a scratch project with a `package.json` `test` script on the allowlist and a `.DS_Store` in it (`touch .DS_Store src/.DS_Store`). Both sides must be 1.0.1: an older side says "Update the Bridge app" or "Update the extension".

1. **Session prompt.** Start a session in a new chat. The prompt starts with "You are connected to my local project…", has RULES before PROJECT FILES, lists your allowlist in rule 3, and has no `.DS_Store`. Send it: the chat replies "Ready.", and no format card appears under it.
2. **Missing closing `@@`.** Ask: "Run the tests, but write the marker without the closing @@, like `@@RUN npm test`." The RUN card appears with a `format fixed` badge. Run it. Then ask for an edit "with the FILE marker missing its closing @@": the diff card says `format fixed` and applies normally.
3. **Format line.** **Send output** on that RUN card: the message box ends with "Bridge format: @@FILE path@@ + full code block · …". Do the same with **Send files** in the side panel and a READ card's **Send these files**.
4. **Format card.** Ask: "Show me the new version of one file as a normal code block with its path above it, no Bridge markers." Under the reply: "The chat didn’t use Bridge’s format", naming the path. **Send format reminder** puts the reminder in the message box without sending. Send it: the chat redoes the reply with `@@FILE` and a diff card appears. Also try "write `@@RUNS npm test@@`" (typo) and "put a `// ...rest unchanged` comment in the file".
5. **Full auto.** Switch to Full auto. Ask for a task and tell the chat to use plain code blocks with no markers for the next two replies. Bridge sends the reminder on its own (the app's Activity says "a format reminder (1 of 2)"), then again, and on the third miss the chip shows **Paused · format issues** and the side panel says the chat kept missing the format. **Resume** carries on with what Bridge could read.
6. **No false alarms.** In a normal session, ask a question that's answered in prose with a shell snippet (`npm install x`), and one that mentions `@@DONE@@` mid-sentence. No format card appears.

### 1.1.0 on the real chatgpt.com

Build (`pnpm build`), reload the extension from `apps/extension/dist`, restart the app. Both sides must be 1.1.0. Use a scratch project with a `package.json` and a `package-lock.json`, open for the first time in the app.

1. **Install.** In Settings → Commands, `npm install` is in the suggestions, ticked, with the hint under it. Allow the list. Start a session: rule 3 ends with "After changing package.json, run the install command: `@@RUN npm install@@`". Ask the chat to add a small dependency. The `package.json` card waits for your click in every mode; apply it. The chat's `@@RUN npm install@@` gets an `allowlisted` card; run it (or let Full auto) and check `node_modules` has the package. Ask it to run `npm install lodash`: the card says `not allowed`.
2. **Existing project.** Open a project whose list was confirmed with 1.0.x: Settings → Commands shows "Add `npm install` to the allowlist?" once. **Dismiss**, reopen the app: it's gone. (Or **Add**: the entry appears.)
3. **Sleep.** Turn on Full auto and ask for a long change across several files. While the reply streams, close the lid for about 3 minutes, then open it. The chip and the side panel say "Waiting for the chat to finish (resumed after sleep)", and when the reply ends Bridge applies it and sends the follow-up with no Resume. If the reply never moves again, after 60s Bridge presses stop on its own, applies what came through and asks the chat to continue.
4. **Stall and cut-off.** In Full auto, mid-reply, set DevTools → Network to **Offline**. The reply errors: the interrupted card says where it stopped, the side panel shows "The chat’s reply was interrupted after …" (Bridge doesn't send while offline). Go back online and click **Resume**: the continuation goes out naming the last marker and the cut-off file. If the page shows **Continue generating**, the side panel offers it first.
5. **Command and sleep.** With a slow allowlisted command running in Full auto (a test with a long `setTimeout`), close the lid for 3 minutes. On waking the side panel shows "A command was interrupted by sleep" with **Re-run** and **Skip**. Check both: Skip sends "The command `…` was interrupted and skipped."
6. **Toggle off.** Turn off **Catch up automatically after sleep** and repeat step 3: Full auto pauses after sleep as in 1.0 and waits for Resume.

While on the live page, save the stop button, Continue generating and an error turn with **Copy diagnostics** (dev build) and update `selectors.ts` and the fixtures if they differ.

### 1.3.0 on the real chatgpt.com

Build (`pnpm build`), reload the extension from `apps/extension/dist`, restart the app. Both sides must be 1.3.0-beta.1. Use a scratch Vite app (`npm create vite@latest`, React or vanilla, then `npm install` in a terminal) opened for the first time in the app.

1. **Dev server.** Settings → Commands: `npm run dev` is suggested with a `background` badge; allow the list. Start a session: rule 3 has a "Dev servers keep running" line with `@@START npm run dev@@`. Ask the chat to start the dev server. Click **Start** on its card: it shows `running` and `http://localhost:5173/`, and so do the app's Session page and the side panel. Click the address; the app opens. Ask for `@@LOGS npm run dev@@` and **Send logs**. Ask it to start the server again: it restarts, still one process.
2. **Fix from the logs.** Turn on Full auto. Ask the chat to make a change, and tell it to put a syntax error in `src/main.ts` (or `.tsx`) on purpose. After the edit, the follow-up says "`npm run dev` printed errors after these edits:" with Vite's error, and the chat's next reply fixes it. Activity groups the run.
3. **Generated image.** Ask the chat to generate a hero image and save it as `public/hero.png`, with `@@ASSET public/hero.png@@` before it. Under the image, **Save to project** has the path filled in (in Full auto it saves on its own). Check the file opens as a PNG, then **Undo**. If the card says Bridge can't read the image, save the page's image element with **Copy diagnostics** (dev build) and update `SELECTORS.generatedImage`.
4. **Download.** Ask the chat to download an icon from an https address into `public/icon.svg` (or `.png`). The card waits for **Download** in every mode; in Full auto the run pauses with "Downloads always need your click". Click it: the file is saved, with a thumbnail for an image. Try an `http://` link (blocked on the card) and a `.png` link that's really a web page (refused: not that type).
5. **Attach.** Take a screenshot into the project as `shot.png`. Side panel → Send files → **Attach** next to it: it appears on the message as an attachment. Ask the chat to look at it with `@@READ shot.png@@`: in Manual the READ card's **Send these files** attaches it; in Full auto it goes with the follow-up and Full auto waits for the upload before sending.
6. **Unlimited and the loop guard.** Settings → Full auto → **Unlimited**: the one-time note appears. Allow a command that always fails the same way (a test file with `expect(1).toBe(2)`) and ask the chat to keep running it without changing anything: on the third identical failure Full auto pauses with "Looks stuck: the same failure repeated".
7. **Auto-approved deletes.** Settings → Full auto → Also approve automatically → **Deletes and renames**: confirm the dialog. In Full auto, ask the chat to delete a scratch file. It's deleted without a click, Activity says "auto-approved", and **Undo** brings it back. Ask it to edit `.env`: still refused.
8. **Cleanup.** End the session: the dev server stops and its port is free (`lsof -i :5173` shows nothing).

### 1.3.0 fixes on the real chatgpt.com

Same setup. For step 5, use a second scratch project with an Express API (`npm init -y`, `npm i express`, a `src/routes/` folder).

1. **New chat.** Start a session in a chat and send it. Click the page's **New chat**, then **Start session** in the side panel: the prompt appears in the visible message box. **End session**, **Start session** again: it appears again. Do it three times without reloading. If it doesn't, save the page's markup around the message box with **Copy diagnostics** (dev build): look for a second `#prompt-textarea`.
2. **Images in Send files.** Put a large photo (over 2048px, a few MB) and a transparent PNG logo in `public/`. Tick both and a text file: the meter says "1 file · 2 images" and counts only the text file; the button says "Insert 1 file and attach 2 images". Click it: both images are on the message (the photo as a JPEG, the logo still a PNG with its transparency), the text file is in the box, and both files on disk are unchanged. Ask the chat to `@@READ` the photo: the READ card says "resized · attached".
3. **Buttons.** Look at a pending diff card (Reject, Apply), a DOWNLOAD card (Reject, Download), a RUN card after a run (Send output, Run again) and a START card while running (Stop, Restart): each pair is the same height.
4. **Conventions and UI guidance.** Start a session in the Vite app: before PROJECT FILES the prompt has rule 9, "PROJECT CONVENTIONS (follow them)" with "Vite + React + TypeScript" (or what you chose) and where things live, and "UI QUALITY" with the 10 rules. Add a `DESIGN.md` at the root and start again: UI QUALITY now says to `@@READ DESIGN.md` and follow it. Settings → Project → UI guidance **Off**, start again: no UI QUALITY. The side panel's size line grows and shrinks with it.
5. **Backend project.** In the Express project, start a session: PROJECT CONVENTIONS says Express and lists `src/routes`; there's no UI QUALITY. In an empty folder: "This project is new…" with the standard layout.
6. **Dev server from `@@RUN`.** With `npm run dev` marked Background, ask the chat to run `@@RUN npm run dev@@`: a START card with `format fixed`, no error. In Full auto it just starts. Ask for a change that ends with `@@START npm run dev@@` and `@@DONE@@`: Full auto applies it, starts the server and ends the run.
7. **Allowlist changed.** Mid-session, add a command in Settings → Commands. Click any Bridge insert (Send files, Send output…): the text starts with "Note: I changed the commands Bridge may run." listing them, background ones separately. The next insert doesn't repeat it.
8. **Background note.** Open a project whose list was confirmed before 1.3.0 (or remove `npm run dev`'s Background tick and its entry from `settings.json`'s `backgroundNoteSeen`): Settings → Commands shows "Add `npm run dev` as a background command?". **Add** allows it, ticked Background; on another project **Dismiss** hides it for good.
9. **Download from URL.** If a generated image's Save card says Bridge can't read it because its server doesn't allow it, **Download from URL** appears; clicking it saves the file (checked as a `@@DOWNLOAD`). Full auto never clicks it.

### 1.3.0 fixes on the real chatgpt.com, round 2

Same setup, with an allowed `npm run build` that isn't Background and `npm run dev` that is.

1. **Pairing code.** Unpair. In the app click **Pair extension**, then **Copy**: it says "Copied". Paste into the side panel's field: it pairs at once (fingerprint shown). Cancel; New code; select the code as shown ("160 508") in the app, copy it with ⌘C and paste: the field shows six digits and pairs. Type five digits and press Enter: nothing is sent, Pair stays off.
2. **Long follow-up.** In Full auto, ask for something whose follow-up is long (`@@READ` two or three large files). The page turns it into a "Pasted text" attachment; Bridge waits until it's processed, sends it once, and the loop goes on, no "send failed". If it ever does pause, Copy diagnostics (dev build) and note what the attachment chip looked like.
3. **Message limit.** On a plan near its limit (or after hitting it), let Full auto send: it pauses with "Message limit reached; resets at …" (the page's time) on the chip, the side panel and the app. If it says "send failed" or "page error" instead, save the banner's markup and update `SELECTORS.usageLimit`.
4. **Background tab.** Start a Full auto run that takes a few steps, switch to another tab for 6 minutes or more: the side panel shows the "Full auto in a background tab" tip once (**Got it** hides it for good) and the run keeps sending at its usual pace. Add chatgpt.com under `chrome://settings/performance` → Memory Saver → "Always keep these sites active".
5. **Tab closed.** Mid-run, close the chat tab: the app's Full auto strip says "The chat tab was closed or unloaded." **Stop** ends it.
6. **`@@START` on a task.** Ask the chat for `@@START npm run build@@`: a RUN card with `format fixed`; in Full auto it runs and its output goes into the next message.
7. **Exit colours.** Run a passing command and a background command that exits 0: `exit 0` is green on the RUN card and neutral on the START card, its dot is grey in the side panel and the app, and Activity's "Background · exited (exit 0)" row isn't red. The START card says **Start again**, the RUN card **Run again**. A failing command is still red.

While on the live page, save a generated image's markup and the composer's file input with **Copy diagnostics** (dev build) and update `selectors.ts` and the fixtures if they differ.
