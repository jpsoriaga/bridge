# End-to-end scripts

Manual Playwright scripts that drive the **built** desktop app and a headless Chrome for Testing with the unpacked extension. They are not part of the pnpm workspace and don't run in CI yet.

## Setup

```bash
pnpm build                                  # apps/desktop/out and apps/extension/dist
npm install --prefix e2e                    # playwright-core only, outside the workspace
npx --prefix e2e playwright-core install chromium
```

Set `CHROMIUM_PATH` to use a different Chromium binary. Each run uses fresh temp directories for the app's userData and the Chrome profile, so it never touches your real pairing.

If your shell sets `ELECTRON_RUN_AS_NODE=1`, the scripts unset it for the app they launch.

## Scripts

| Command                  | What it checks                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node e2e/run.cjs .`     | Wrong then right pairing code, `tokenHash`-only storage, encrypted `pairing.json`, unpair from either side, app quit and relaunch (alarm set, then cleared), 5-wrong-code lockout                                                                                                                                                                                                                                 |
| `node e2e/probe.cjs .`   | Which loopback calls the worker can make with and without `host_permissions` (the Phase 2 decision in PLAN.md)                                                                                                                                                                                                                                                                                                    |
| `node e2e/project.cjs .` | Phase 3: tree, read, write, undo and sandbox refusals through a dev build                                                                                                                                                                                                                                                                                                                                         |
| `node e2e/chat.cjs .`    | Phases 4–5 against a stand-in chatgpt.com served from the fixtures: allowlist confirmed in the app, start session (prompt lists the allowlist), card fonts on dynamic URLs, Apply/Undo, Apply all, READ card, conflict, reload, regenerate, Auto-apply with a gated file and Undo all, a 2-step Full auto run to `@@DONE@@` (3s gap checked), End session back to Manual. `E2E_SCREENSHOTS=dir` saves screenshots |

The argument is the repo root. Each script prints one line per step and ends with `E2E OK` or exits non-zero.

Ports 47821–47830 must be free of other Bridge instances while a script runs.

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
