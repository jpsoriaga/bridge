# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. The images in this folder come from `node e2e/screenshots.cjs .` (RELEASE.md has the upload steps). Keep the listing free of OpenAI or Codex names, logos and colours: ChatGPT is mentioned only to say what Bridge works with.

## Store listing

**Name:** Bridge

**Short description** (132 characters at most):

> Review file edits from the chat on chatgpt.com and apply them to a project on your computer, through the Bridge desktop app.

**Category:** Developer Tools

**Language:** English

**Detailed description:**

> Bridge connects the chat on chatgpt.com to a project folder on your computer, so the code the chat writes lands in your files only after you've seen it.
>
> Bridge needs the free Bridge desktop app (macOS, Windows or Linux), which does all the reading and writing. Download it from https://github.com/jpsoriaga/bridge/releases and pair it with the extension once.
>
> How it works
> • Start a session from the side panel. Bridge puts short instructions and your project's file list into the message box; you send it.
> • When the chat replies with a file, Bridge shows a diff card under it: what changes, line by line. Click Apply to write it, or Reject. Every change can be undone.
> • The chat can ask to see files, and you send them with one click. Deletes and renames get their own cards and always need your click.
> • Commands you allowlist in the app (like your test script) can run from a card, and their output goes back to the chat when you choose.
>
> Modes
> • Manual: you review and apply every edit.
> • Auto-apply: edits apply as soon as a reply finishes, each with Undo.
> • Full auto (opt-in): Bridge applies edits, runs allowlisted commands and sends the results back on its own, up to a step limit, with Stop always in reach. Automating the chat may break its provider's terms of use; read the warning before turning it on.
>
> Private and local
> • The extension talks only to the Bridge app on your own computer (127.0.0.1). No accounts, no analytics, no data sent anywhere else.
> • The app only touches files inside the folder you open. It refuses paths that climb out of it and never touches .git, .env files, keys or node_modules.
> • Pairing is confirmed with a fingerprint you compare in both places. Likely secrets are redacted before anything goes into the chat.
>
> Bridge is open source (MIT): https://github.com/jpsoriaga/bridge
>
> Not affiliated with or endorsed by OpenAI. ChatGPT is a trademark of its owner; Bridge only works alongside it.

**Homepage URL:** https://github.com/jpsoriaga/bridge

**Support URL:** https://github.com/jpsoriaga/bridge/issues

## Images

| Field                 | File                                                                                                         | Size                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Store icon            | [`icon-128.png`](icon-128.png)                                                                               | 128×128 (the extension's own icon) |
| Screenshots (up to 5) | [`screenshots/`](screenshots): `1-chat-*`, `2-app-session-*`, `3-app-activity-*`, each in `light` and `dark` | 1280×800                           |
| Small promo tile      | [`promo-tile-440x280.png`](promo-tile-440x280.png) (source: [`promo-tile.html`](promo-tile.html))            | 440×280                            |

Suggested upload order (five): `1-chat-light`, `1-chat-dark`, `2-app-session-light`, `3-app-activity-light`, `2-app-session-dark`.

Captions, if the dashboard asks: "Diff cards under the chat's reply, and the side panel" · "The Bridge desktop app: project, pairing and mode" · "Activity: every change, with its diff and Undo".

## Privacy practices

**Single purpose:**

> Bridge lets the user review file edits proposed in the chat on chatgpt.com and apply them to a local project folder through the Bridge desktop app running on the same computer.

**Permission justifications:**

| Permission                                | Justification                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                 | Keeps the state of chat sessions and of the cards under each reply (applied, rejected, undone), the desktop app's port, and where the user put the page chip, so they survive a reload. Never stores file contents, command output or messages. |
| `sidePanel`                               | Bridge's controls live in the side panel: connection and pairing, starting and ending a session, the mode, files sent to the chat, and Stop.                                                                                                    |
| `alarms`                                  | One alarm wakes the service worker once a minute while it's paired but not connected, so it reconnects to the desktop app soon after the app starts, even after Chrome suspended the worker. Cleared once connected.                            |
| Host permission `http://127.0.0.1/*`      | The extension's only network access: the Bridge desktop app on the user's own computer, at 127.0.0.1 (ports 47821–47830), for its health check, pairing and unpairing. It never contacts any other host.                                        |
| Content script on `https://chatgpt.com/*` | Reads the assistant's replies on chatgpt.com to find Bridge's file markers, shows review cards under them in a closed shadow root, and puts text into the message box when the user clicks a button. It runs on no other site.                  |

**Remote code:** No, I am not using remote code. (All scripts are in the package; the extension pages' CSP is `script-src 'self'`.)

**Data usage** (what the dashboard asks "Does your extension collect…"): tick **none** of the categories (personally identifiable information, health, financial and payment, authentication, personal communications, location, web history, user activity, website content). Bridge reads the chat page and the user's files only to show and apply edits on the user's own computer, and transmits nothing off the device: its only connection is to the user's own Bridge app on 127.0.0.1.

Certify all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/jpsoriaga/bridge/blob/main/PRIVACY.md

## Distribution

- Visibility: Public (or Unlisted for a soft launch).
- Regions: all.
- Pricing: free.
