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

| Command                  | What it checks                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node e2e/run.cjs .`     | Wrong then right pairing code, `tokenHash`-only storage, encrypted `pairing.json`, unpair from either side, app quit and relaunch (alarm set, then cleared), 5-wrong-code lockout                    |
| `node e2e/probe.cjs .`   | Which loopback calls the worker can make with and without `host_permissions` (the Phase 2 decision in PLAN.md)                                                                                       |
| `node e2e/project.cjs .` | Phase 3: tree, read, write, undo and sandbox refusals through a dev build                                                                                                                            |
| `node e2e/chat.cjs .`    | Phase 4 against a stand-in chatgpt.com served from the fixtures: start session, Apply/Undo, Apply all, READ card, conflict, reload, regenerate, End session. `E2E_SCREENSHOTS=dir` saves screenshots |

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
