# Changelog

All notable changes to Bridge are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Bridge uses [semantic versioning](https://semver.org/). The desktop app and the extension always share one version.

## [Unreleased]

## [1.3.0-beta.1] - 2026-10-24

Dev servers that keep running, images and other binary files, and a Full auto that needs fewer clicks. The app and the extension must both be 1.3.0-beta.1: if one is older, both say which to update. Pairings carry over.

### Added

- **Dev servers in the background.** Mark an allowed command as **Background** in Settings → Commands (`dev`, `start`, `serve`, `preview` and `watch` scripts start out marked). The chat starts it with `@@START npm run dev@@`, stops it with `@@STOP npm run dev@@`, and asks for its last 80 lines with `@@LOGS npm run dev@@`. It has no timeout and keeps running between messages; at most three run at once, and starting one again restarts it instead of starting a second. The app and the side panel show each one with its address (click to open it), how long it's been running, **Stop** and **View logs**. Logs keep the last 2,000 lines, with likely secrets redacted. Everything stops, with whatever it started, when the session ends, you switch projects, quit Bridge or the computer sleeps for more than 30 minutes.
- **Dev server errors in Full auto.** After applying edits, Full auto gives running dev servers a moment to rebuild and sends the errors they printed with the next message.
- **Save images the chat makes.** Each image the chat generates gets a **Save to project** card, its path filled in from `@@ASSET public/hero.png@@` in the reply. Save writes it into the project (re-encoded if the name asks for another format), backed up, with Undo; Auto-apply and Full auto save it on their own when the chat named the path.
- **Downloads.** `@@DOWNLOAD https://… -> public/logo.svg@@` gets a card that downloads only when you click, in every mode. https only, never from your computer or local network, 20 MB at most, and only images, fonts, audio, video, JSON and text that really are what their name says (checked from the file itself). SVGs with scripts or event handlers are refused.
- **Binary files with backups and undo.** Images and downloads go through the same protected-path checks, gated files, backups and undo as text, up to 20 MB. The app's Activity shows a thumbnail of an image Bridge wrote.
- **Attach images to the chat.** In the side panel's **Send files**, images have **Attach**, which adds the file to the message as a real attachment. When the chat asks for an image with `@@READ`, Bridge attaches it instead of pasting text, on its own in Full auto.
- **Unlimited step limit.** Settings → Full auto → **Unlimited**, with a one-time note: on the Free and Go plans every step uses a message.
- **Loop guard.** With or without a limit, Full auto pauses with "Looks stuck: the same failure repeated" when the same command fails the same way three times in a row, or the same file is written with the same content three times.
- **Also approve automatically** (Settings → Full auto, each off by default): deletes and renames, gated files (`package.json`, lockfiles, configs) and partial-looking files. Turning one on asks you to confirm what it lets Full auto do. Everything approved this way is backed up and marked "auto-approved" in Activity. Commands off the allowlist, downloads, protected files and files changed on disk always wait for you.
- **Project conventions in the session prompt.** Bridge looks at the project's files and `package.json` and tells the chat how it's built: the framework and language, where things live (components, pages, static files…), how files are named and how it's styled, so the chat follows them. A new or empty project gets the standard layout for its framework instead. A new rule asks the chat to follow the project's structure and not reorganise files unless you ask.
- **UI guidance.** For projects with a UI (React, Vue, Svelte, Next, Vite, Astro, or HTML and CSS), the session prompt asks the chat for polished, accessible design: reuse what's there, one spacing scale and a clear type hierarchy, a small palette, WCAG AA contrast and focus states, responsive layouts, every state designed, real copy, nothing that looks generic. A project with its own design rules (`DESIGN.md`, `design-system.md`, `STYLEGUIDE.md`, a tokens file or a Tailwind config) is told to read and follow those instead. Settings → Project → **UI guidance**: Auto (the default), Always or Off.
- **The chat hears when you change the allowed commands.** Change the list in the middle of a session and the next message Bridge puts in the chat starts with a short note listing what's allowed now and which are background commands.
- **Add your dev server as a background command.** Projects set up before this version get a one-time note in Settings → Commands, "Add `npm run dev` as a background command?", with **Add** and **Dismiss**.
- **Download from URL.** When the chat makes an image the page won't let Bridge read (it's served from another site), the Save to project card offers **Download from URL**, which has the app fetch it from its https address, only when you click, with the same checks as `@@DOWNLOAD`.
- **Install steps on every release page.** Release notes now open with **How to install**: which file to download for each computer, how to open the unsigned app, how to add the extension and pair, and which files to ignore. Each release also has a `Bridge-<version>-INSTALL.md` with troubleshooting and uninstall steps, and the extension zip has a `README.txt` with the Load unpacked steps.

### Changed

- **Images in Send files are attached.** Ticking an image attaches it to the message instead of pasting it as text. The character budget counts text files only and shows images separately ("2 files · 1 image"), and the button says what it will do ("Insert 2 files and attach 1 image").
- **Large images are made to fit.** Before an image is attached (Send files, `@@READ`, Full auto), anything over 2048 pixels on its longest side is scaled down and recompressed to under 5 MB: PNG when it has transparency, JPEG otherwise. The file in your project is never changed. Only an image that still can't be made small enough is refused, and the card or panel says why.
- **Card buttons are all the same height.** Every button on the chat's cards (Apply and Reject, Run and Cancel, Start and Stop, Save, Download…) now has one size, so pairs line up.
- **`@@RUN` on a dev server starts it.** When the chat writes `@@RUN npm run dev@@` for a command marked Background, Bridge treats it as `@@START` (the card says `format fixed`), and Full auto just starts it.
- **Full auto starts the dev server at the end.** A `@@START` in a reply that also says `@@DONE@@` is acted on before the run ends.
- **Step limit 25 by default**, from 1 to 100 (was 10, up to 25). A limit of 10 saved by an earlier version, which was the old default, moves to 25.
- **Session prompt** teaches the new markers: dev servers (only when the project has a background command), `@@ASSET`, `@@DOWNLOAD`, and that binary files can't be written as text.
- **Protocol 8.** New messages for binary files, downloads and background processes.

### Fixed

- **Start session after New chat.** After clicking New chat on the chat page, Start session could insert nothing, again and again, until the page was reloaded: the page can keep the previous chat's message box on the page, hidden, and Bridge pasted into that one. Bridge now only uses the message box, send and stop buttons you can see.
- **Images counted as characters.** Ticking an image in Send files no longer counts its size as characters and then refuses it as too large.
- **Install notes** no longer use the Apple logo character, which doesn't show outside Apple devices: they say "Apple menu (top-left corner of the screen)".
- **Files the chat asked for no longer wait for a click in Full auto.** A reply that finished while the app was briefly out of reach (reconnecting, or after sleep) was skipped, leaving its READ card on **Send these files**. It's now acted on once the app is back. Requested files are also read before anything else can pause the step, so they go out with the next message; protected ones are reported as refused. A format reminder now carries the files the reply asked for, and a reply whose text changed after it finished no longer leaves a second READ card waiting.

### Removed

- **Screenshots in the README.** They're still in `docs/screenshots/`.

## [1.2.0-beta.3] - 2026-10-23

The release build for 1.2.0-beta.2 failed on the Intel Mac smoke test, so this beta replaces it. The app and extension are the same as in 1.2.0-beta.2.

### Added

- **Release dry run.** Running the release workflow by hand builds, verifies and smoke-tests every package and uploads them, but never creates a release. RELEASE.md now runs it before tagging.

### Fixed

- **Intel Mac release build.** The release workflow no longer smoke-tests the Intel Mac build, which never opened its window under Rosetta on GitHub's Apple silicon runner. It is still checked for its security settings and package contents, and is launched by hand before publishing. Run locally, the smoke test gives an Intel build under Rosetta 120 seconds to open its window (other builds keep 90 seconds), tests each build with fresh app data, and starts the next only after the previous one has fully quit and freed its port.

## [1.2.0-beta.2] - 2026-10-23

The release build for 1.2.0-beta.1 failed, so this is the first beta testers can download. It has everything listed under 1.2.0-beta.1, plus the fixes below.

### Fixed

- **Unsigned macOS packaging.** When no signing secrets are set, empty signing variables are now dropped before packaging, so the unsigned macOS build no longer fails with "not a file".
- **Linux smoke test hang.** The release smoke test now ends the app's whole process tree when it passes or fails, exits, and stops after 3 minutes at most. Every release and CI job also has a time limit.

## [1.2.0-beta.1] - 2026-10-23

The first beta for testers on macOS, Windows and Linux, with install steps in [BETA.md](https://github.com/jpsoriaga/bridge/blob/v1.2.0-beta.1/BETA.md) and an easy way to report problems.

### Added

- **Beta releases.** Versions like `1.2.0-beta.1` are published as GitHub pre-releases, never marked Latest, with the Load unpacked extension zip (no store zip). The app shows the full version in Settings → About, and the extension at the bottom of the side panel and on `chrome://extensions`.
- **Update channel.** Settings → About → **Stable** or **Beta**. Beta builds start on Beta and hear about newer betas and releases; Stable never shows a beta. Still notify only: nothing is downloaded or installed.
- **Copy diagnostics.** In the app (Help → Copy diagnostics, or Settings → About) and at the bottom of the side panel: the app and extension versions, the protocol, your system and browser, the mode, the connection and the last 50 log lines, for bug reports. Never file contents, keys or tokens; likely secrets are redacted and paths start at `~`.
- **A log file.** The app logs what happens (not file contents) to `logs/bridge.log` in its data folder, rotated at 5 MB with two older files kept, with the same redaction. Help → **Open logs folder** shows it.
- **Beta issue templates** on GitHub: "Beta bug report" (with a field for the diagnostics) and "Beta feedback".

### Fixed

- **Blank markers are ignored.** A marker with only spaces where its path or command goes (`@@RUN   @@`, `@@FILE   @@`, or `` `@@RUN @` `` with a half-written closer) no longer becomes a card for a blank path or command, or for `@`.

## [1.1.0] - 2026-10-23

The chat can now install dependencies after you approve a `package.json` change, and Full auto keeps going when your computer sleeps mid-reply instead of waiting for Resume.

### Added

- **The install command, allowed by default.** A new project's suggested commands include its package manager's install command (`npm install`, `pnpm install`, `yarn install` or `bun install`, from the lockfile; npm without one), already ticked. It's an exact entry: it installs only what `package.json` lists, and `npm install <pkg>`, `npm i`, `npx`, `dlx` and `npm create` stay refused. `package.json` and lockfile edits still need your click in every mode. The session prompt asks the chat to run it after changing `package.json`.
- **Install timeout.** The install command gets its own timeout, 5 minutes by default (other commands keep 2 minutes), under Settings → Commands.
- **A one-time offer for existing projects.** Settings → Commands asks once whether to add the install command to a list confirmed before this version, with **Add** and **Dismiss**. It's never added on its own.
- **Catching up after sleep.** On waking, Full auto reconnects and looks at the reply it was waiting for. Still streaming: it waits ("Waiting for the chat to finish (resumed after sleep)") and carries on. Finished meanwhile: it acts on it ("Caught up after sleep"). No new text for 60 seconds: it presses the chat's stop button once, acts on what came through and asks the chat to continue, then pauses with **Stop & continue** if it sticks again. A command running when the computer slept asks **Re-run** or **Skip**. A changed conversation, session or project keeps it paused, saying why. **Settings → Full auto → Catch up automatically after sleep** (on by default) turns it off.
- **Cut-off replies.** A reply cut off by an error or the network has only its finished blocks applied, never the file it was writing, and a card says where it stopped. Full auto asks the chat once to continue from the last marker that came through (or presses the page's own **Continue generating** when it offers one), and pauses with **Resume** if the next reply is cut off too. In other modes the card's **Insert continuation** puts the request in the message box without sending.

### Changed

- **Protocol 7.** Update the app and the extension together; if one is older, both say which one to update. Your pairing carries over.

## [1.0.1] - 2026-10-19

When the chat slipped out of Bridge's format (for example `@@RUN npm test` without the closing `@@`), Bridge showed nothing. Now it reads the common slips, says when it can't, and helps get the chat back on track.

### Added

- **Format reminder.** A reply that looks meant for Bridge but isn't in its format (a marker with a typo, a file's code block with no `@@FILE` marker, `@@FILE` with no code block, a "rest unchanged" placeholder) gets a card saying so. **Send format reminder** puts a short reminder in the message box; you press send.
- **Full auto reminds the chat itself.** Instead of acting on a reply it can't fully read, Full auto sends the reminder, at most once per step and twice per run. After that it pauses with "format issues".
- **A format line on everything Bridge inserts.** Files, command output, Resend changed and Full auto follow-ups end with one line restating the markers.

### Changed

- **Markers missing their closing `@@` still work.** In inline code, `@@RUN`, `@@READ`, `@@DELETE`, `@@RENAME` and `@@DONE` without the closing `@@` are read anyway, and `@@FILE` too when a code block follows. Their cards say "format fixed".
- **A tighter session prompt.** The rules come first, before the file list, with every marker shown exactly, and the chat is asked to check its markers before each reply.
- **Junk files hidden.** `.DS_Store`, `Thumbs.db` and `desktop.ini` no longer appear in Send files or the session prompt's file list.
- **Protocol 6.** Update the app and the extension together; if one is older, both say which one to update. Your pairing carries over.

## [1.0.0] - 2026-10-19

The first release: a desktop app for macOS, Windows and Linux, and a Chrome extension, that let the chat on chatgpt.com propose file edits you review and apply to a project on your computer.

### Added

- **Desktop app and extension, connected over loopback only.** The app listens on `127.0.0.1` (ports 47821–47830), checks `Host` and `Origin`, and accepts only the paired Bridge extension. Pairing uses a 6-digit code, an ECDH key exchange and a fingerprint you confirm in both places; after that both sides prove they hold the key with a mutual HMAC challenge. The key never crosses the wire.
- **Projects and a path sandbox.** Open a folder in the app. Every path from the chat is checked: no absolute paths, `..`, symlinks or hard links out of the project, and never `.git/`, `.env*`, keys or `node_modules/` (plus your own protected patterns). Writes are atomic, conflict-checked against the file you saw, and backed up first, so every change can be undone from the app's Activity page.
- **Chat integration.** Start session puts instructions and your file list into the message box. Replies with `@@FILE` blocks get diff cards with Apply, Reject and Undo; `@@READ` asks for files; `@@DELETE` and `@@RENAME` get their own cards and always need a click. Send files, files in context with stale detection, and Resend changed.
- **Modes.** Manual (review every edit), Auto-apply (edits apply when a reply finishes, with Undo and Undo all) and the opt-in Full auto, which applies edits, runs allowlisted commands and sends the follow-up itself within a step limit, with Stop everywhere and pauses on anything that needs you.
- **Commands.** RUN cards run commands from an allowlist you set per project: exact matches, a trailing `*` for extra arguments, a table of refused options, no shell, a filtered environment, a timeout that kills the whole process tree, and capped output. Likely secrets are redacted from everything Bridge puts into the chat.
- **App.** Session, Activity (filters, search, diffs, command output) and Settings pages, a first-run checklist, light and dark themes, keyboard and screen reader support, and your login shell's PATH for commands even when opened from the Dock.
- **Hardening.** Electron sandbox, context isolation, a strict CSP, every IPC call validated, navigation and permissions refused, and Electron fuses set in the packaged app. Server limits on message size, connections, timeouts and per-operation rates. Private file modes for keys, settings and backups. See [SECURITY.md](https://github.com/jpsoriaga/bridge/blob/main/SECURITY.md).
- **Packaging and release.** Installers for macOS (dmg and zip, Apple silicon and Intel), Windows (per-user NSIS installer, no admin rights) and Linux (AppImage), built and checked by GitHub Actions on a version tag, with fuses verified, package contents checked and each app smoke-tested. Signing and notarization turn on when their secrets are set. A Chrome Web Store zip of the extension.
- **Update check, notify only.** Settings → About shows the version and can ask GitHub Releases whether a newer one exists, on a click or (if you turn it on) at launch. It never downloads or installs anything, and it's off in unsigned macOS builds.
- **Version handshake.** If the app and the extension speak different protocol versions, both say which one to update instead of failing to connect.

[Unreleased]: https://github.com/jpsoriaga/bridge/compare/v1.3.0-beta.1...HEAD
[1.3.0-beta.1]: https://github.com/jpsoriaga/bridge/compare/v1.2.0-beta.3...v1.3.0-beta.1
[1.2.0-beta.3]: https://github.com/jpsoriaga/bridge/compare/v1.2.0-beta.2...v1.2.0-beta.3
[1.2.0-beta.2]: https://github.com/jpsoriaga/bridge/compare/v1.2.0-beta.1...v1.2.0-beta.2
[1.2.0-beta.1]: https://github.com/jpsoriaga/bridge/compare/v1.1.0...v1.2.0-beta.1
[1.1.0]: https://github.com/jpsoriaga/bridge/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/jpsoriaga/bridge/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jpsoriaga/bridge/releases/tag/v1.0.0
