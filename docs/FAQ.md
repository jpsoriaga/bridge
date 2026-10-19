# FAQ

**What is Bridge, in one line?**
A desktop app and a Chrome extension that let the chat on chatgpt.com propose whole-file edits to a project on your computer, which you review as diffs and apply with a click, with undo.

**Is it made by OpenAI?**
No. Bridge is an independent open-source project. It isn't affiliated with or endorsed by OpenAI; it only works alongside the chat page in your browser.

**Does Bridge send my code anywhere?**
Bridge itself doesn't: the extension talks only to the Bridge app on your computer (`127.0.0.1`), and there's no telemetry. What you put into the chat (instructions, files you send, command output you send) goes to the chat service, as anything you type there does. See [PRIVACY.md](../PRIVACY.md).

**Why do I need a desktop app? Can't the extension write files?**
Browser extensions can't write into arbitrary folders on disk or run commands, and shouldn't. The app does the reading, writing and running, behind a path sandbox, an allowlist and undo, and the extension only asks.

**Why does macOS or Windows warn about the app?**
The release isn't signed yet. Signing needs paid certificates from Apple and a Windows certificate authority. README.md, "Install the app", has the one-time steps, and `SHA256SUMS.txt` on the release lets you check the file.

**Can the chat touch files outside my project?**
No. Every path is checked: no absolute paths, no `..`, no links that lead out, no files with extra hard links, and never `.git/`, `.env` files, keys or `node_modules/`. The check runs again right before each write. [SECURITY.md](../SECURITY.md) lists every control and its limits.

**Can it run any command?**
Only commands you allowlist in the app, matched exactly (or with extra arguments if you end an entry with `*`), without a shell, and never with options that would let a program run other code. Nothing in the chat or the extension can change the list.

**What happens if I don't like an edit after applying it?**
Click **Undo** on the card, or find it on the app's **Activity** page. Bridge backs up every file before it changes, deletes or renames it, for 7 days by default.

**What's the difference between the modes?**
**Manual**: you click Apply on each edit. **Auto-apply**: edits apply as soon as a reply finishes, each with Undo. **Full auto**: Bridge also runs allowlisted commands and sends the results back to the chat on its own, up to a step limit. Deletes, renames and a few risky files always wait for a click.

**Is Full auto safe to use?**
It's opt-in and comes with a warning. Automating the chat may break its provider's terms of use and risk your account, and the commands it runs (like your tests) execute code the model may have written. Use it on projects where you'd be fine with that, and keep the step limit low.

**Does it work with other chat sites?**
Not yet. The extension runs only on `https://chatgpt.com`.

**Does it work in Edge, Brave or Arc?**
Yes, in Chromium browsers with side panel support. Firefox and Safari aren't supported.

**Why did the side panel say "Update the Bridge app" (or "Update the extension")?**
The two are on versions that speak different protocols. Update the one it names; it reconnects by itself afterwards.

**Does Bridge check for updates?**
Only when you ask: **Settings → About → Check for updates**, or at launch if you turn that on. It asks GitHub for the latest version number and links to it; it never downloads or installs anything.

**Where are my settings and backups? How do I remove everything?**
README.md, "Where data lives" and "Uninstall", has the folder for each system and the steps.

**I found a security problem.**
Please report it privately: [SECURITY.md](../SECURITY.md), "Reporting a problem".
