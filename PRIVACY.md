# Privacy policy

_Effective 24 October 2026 (downloads and images added in 1.3.0; first published 19 October 2026). Applies to the Bridge desktop app and the Bridge Chrome extension, version 1.0.0 and later._

Bridge is a personal open-source tool by Jaypee Soriaga. It has no servers, no accounts and no analytics. Everything it does happens on your computer.

## The short version

- Bridge collects **no data** about you. There is no telemetry, no analytics, no crash reporting and no account.
- The extension talks **only to the Bridge app on your own computer** (`127.0.0.1`). It never sends anything to the developer or to any other server. When you save an image the chat made, it reads that image from the chat page you're on (`chatgpt.com`), as the page already shows it.
- The desktop app makes **no network requests** except to that extension on loopback, and, only if you ask it to: one request to GitHub to see whether a newer version exists (see "Update check"), and a download the chat suggested, when you click **Download** on its card (see "Downloads").
- What you choose to send to the chat (files, command output) goes to the chat service you use, under its own privacy policy. Bridge doesn't see or keep what the chat does with it.

## What the extension stores, and where

All of it stays in your Chrome profile, on your computer.

| What                                                                                                                                      | Where                                                                                              | Why                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The pairing key                                                                                                                           | The extension's own IndexedDB (in its service worker; web pages and content scripts can't open it) | To prove to the Bridge app that it's the paired extension            |
| The app's port number                                                                                                                     | `chrome.storage.local`                                                                             | To reconnect to the app quickly                                      |
| Chat sessions: the conversation ID, when it started or ended, file paths sent to the chat with their size and a hash, and counts of edits | `chrome.storage.local`                                                                             | So a reload or another tab shows the session as it was               |
| Card states: a key per card (conversation, message, a hash), its state (applied, rejected, undone), an operation ID and counts            | `chrome.storage.local`                                                                             | So the cards under a reply look the same after a reload              |
| Which tab a new session is waiting in, and where you put the page chip                                                                    | `chrome.storage.session` and `chrome.storage.local`                                                | To bind a session to its conversation and remember the chip's corner |

The extension **never stores file contents, command output or messages**. Sessions and card states are deleted 30 days after they were last used. Removing the extension deletes all of it.

The extension also keeps a short list of recent events (connected, paired, a session started, Full auto paused) **in memory only**, for **Copy diagnostics** in the side panel. It's gone whenever Chrome stops the extension's background worker, and it's only copied to your clipboard when you click the button.

The extension reads the chat page on `https://chatgpt.com` only, and only to find Bridge's markers in the assistant's replies, show cards under them, and put text into the message box when you click a button. It doesn't read or keep your conversations.

## What the desktop app stores, and where

In its data folder, readable only by your user account:

- macOS: `~/Library/Application Support/Bridge`
- Windows: `%APPDATA%\Bridge`
- Linux: `~/.config/Bridge`

| What                                                                                                                                                                                                                               | Why                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `settings.json`: the open project's path, your last 5 projects, protected and gated patterns, allowlisted commands, mode and other settings, window position                                                                       | To come back the way you left it                                                                 |
| `pairing.json` and `server-key.json`: the pairing key and the app's own key, encrypted with your system keychain where available                                                                                                   | To recognise the paired extension                                                                |
| `backups/`: a copy of each file before Bridge changed, deleted or renamed it, and a log of those changes                                                                                                                           | So you can undo. Kept for 7 days by default (1–90, in Settings), and you can clear them any time |
| `logs/bridge.log`: what happened (started, connected, a project opened, a change applied or refused, a command's exit code), never file contents, command output or keys; likely secrets removed and your home folder shown as `~` | For bug reports. At most 5 MB, plus two older files; older lines are deleted                     |

The app writes inside the project folder you opened, and only when you (or a mode you turned on) apply a change. Command output is kept in memory for the Activity page and is gone when the app quits.

**Copy diagnostics** (Help menu, or Settings → About) puts the versions, your system, the mode, the connection state and the last 50 log lines on your clipboard, with likely secrets removed. Nothing is sent anywhere: you decide whether to paste it into a bug report.

## Update check

Settings → About has **Check for updates**. When you click it, or at launch if you turned on "Check for updates when Bridge starts" (off by default), the app asks GitHub (`github.com`, which hosts Bridge's releases) for the latest version number (on the **Beta** update channel, pre-releases too). That request carries what any web request does (your IP address and a user agent) and nothing about you, your projects or your chats. GitHub's privacy statement applies to it. Nothing is downloaded or installed; the app shows a link if a newer version exists. Unsigned macOS builds never check.

## Downloads

When the chat suggests a file to download (`@@DOWNLOAD https://… -> path`), Bridge shows a card and does nothing until you click **Download**, in every mode. Then the app requests that https address, and only that one (and the addresses it redirects to), with no cookies and no referrer. The request carries what any web request does (your IP address and a user agent saying "Bridge") and nothing about you, your projects or your chats. The server you download from sees that request under its own terms. The file is saved in your project like any other change Bridge makes, with a backup.

## Permissions the extension asks for

- **Read and change data on chatgpt.com**: to find Bridge's markers in replies, show cards, fill the message box or attach an image when you click, and read an image the chat made when you save it.
- **`http://127.0.0.1/*`**: to reach the Bridge app on your own computer. Nothing outside your computer.
- **Storage**: for the session and card states above.
- **Side panel**: Bridge's controls.
- **Alarms**: to reconnect to the app within a minute after Chrome suspends the extension.

## Sharing and selling

Bridge doesn't share, sell or transfer any data, because it doesn't collect any. Nothing is used for advertising, credit decisions or anything other than Bridge's single purpose.

## Children

Bridge isn't directed at children and collects no information from anyone.

## Deleting everything

Remove the extension in `chrome://extensions`, uninstall the app, and delete the app's data folder above. README.md, "Uninstall", has the steps for each system.

## Changes

If this policy changes, the new version will be in this file, with its date, in the repository at https://github.com/jpsoriaga/bridge, and noted in the changelog.

## Contact

Questions: open an issue at https://github.com/jpsoriaga/bridge/issues. For a security problem, see [SECURITY.md](SECURITY.md).

Bridge is not affiliated with or endorsed by OpenAI.
