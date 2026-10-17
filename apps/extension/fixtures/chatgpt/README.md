# ChatGPT message fixtures

Hand-sanitised copies of chatgpt.com conversation turns, for the adapter tests in
`src/content/chat/adapter.test.ts`. Class lists are trimmed, ids are made up, and the
conversation text is invented. The structure (turn `article`, `data-message-author-role`,
`.markdown`, the code block header inside `<pre>`, the turn action buttons) follows the page
as of October 2026.

When chatgpt.com changes its markup, save a fresh turn from DevTools (right-click the
`article` → Copy → Copy outerHTML), strip personal text and long class lists, and add or
update a fixture here. Keep one scenario per file.

| File                  | Scenario                                                            |
| --------------------- | ------------------------------------------------------------------- |
| `single-edit.html`    | One `@@FILE` marker in inline code and its code block               |
| `multiple-edits.html` | Two edits, an unrelated shell block, a bolded `__init__.py`, READs  |
| `streaming.html`      | A reply still streaming: `result-streaming`, no action buttons      |
| `code-header.html`    | Code block header ("typescript", Copy) inside `<pre>`, nested fence |
| `user-message.html`   | A user turn containing `@@CONTEXT` and a typed `@@FILE` block       |
