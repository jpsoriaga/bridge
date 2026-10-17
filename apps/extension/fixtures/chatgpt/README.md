# ChatGPT message fixtures

Hand-sanitised copies of chatgpt.com conversation turns, for the adapter tests in
`src/content/chat/adapter.test.ts`. Class lists are trimmed, ids are made up, and the
conversation text is invented. The structure (turn `article`, `data-message-author-role`,
`.markdown`, the code block header inside `<pre>`, the turn action buttons) follows the page
as of October 2026.

When chatgpt.com changes its markup, save a fresh turn from DevTools (right-click the
`article` → Copy → Copy outerHTML), strip personal text and long class lists, and add or
update a fixture here. Keep one scenario per file.

| File                  | Scenario                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `single-edit.html`    | One `@@FILE` marker in inline code and its code block                                                                                                                                                                                                                                |
| `multiple-edits.html` | Two edits, an unrelated shell block, a bolded `__init__.py`, READs                                                                                                                                                                                                                   |
| `streaming.html`      | A reply still streaming: `result-streaming`, no action buttons                                                                                                                                                                                                                       |
| `code-header.html`    | Code block header ("typescript", Copy) inside `<pre>`, nested fence                                                                                                                                                                                                                  |
| `user-message.html`   | A user turn containing `@@CONTEXT` and a typed `@@FILE` block                                                                                                                                                                                                                        |
| `dil-renderer.html`   | The newer layout (Oct 2026): `data-turn-key`, `data-talvt-turn-state`, `…:assistant` units, READ/RUN markers; a finished and a streaming turn. Rebuilt from **Copy diagnostics**, code block included (`<pre>` in `[data-code-block]`, header marked `data-markdown-copy="exclude"`) |

Full auto (Phase 5) also relies on `SELECTORS.sendButton`, `SELECTORS.userMessage` and `SELECTORS.errorBanner` (with `ERROR_TEXT`). There are no saved fixtures for these yet: the e2e stand-in page imitates them. When checking the live site, save the composer's send button and an error or usage-limit banner too.

The side panel's **Copy diagnostics** (dev builds) reports what the page script sees, including the tags and `data-*` attributes around the newest `@@` marker and around code blocks, without any message text. Use it to update `selectors.ts` and these fixtures.
