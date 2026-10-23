# Changelog

All notable changes to Bridge are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Bridge uses [semantic versioning](https://semver.org/). The desktop app and the extension always share one version.

## [Unreleased]

### Added

- **Install steps on every release page.** Release notes now open with **How to install**: which file to download for each computer, how to open the unsigned app, how to add the extension and pair, and which files to ignore. Each release also has a `Bridge-<version>-INSTALL.md` with troubleshooting and uninstall steps, and the extension zip has a `README.txt` with the Load unpacked steps.

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

[Unreleased]: https://github.com/jpsoriaga/bridge/compare/v1.2.0-beta.3...HEAD
[1.2.0-beta.3]: https://github.com/jpsoriaga/bridge/compare/v1.2.0-beta.2...v1.2.0-beta.3
[1.2.0-beta.2]: https://github.com/jpsoriaga/bridge/compare/v1.2.0-beta.1...v1.2.0-beta.2
[1.2.0-beta.1]: https://github.com/jpsoriaga/bridge/compare/v1.1.0...v1.2.0-beta.1
[1.1.0]: https://github.com/jpsoriaga/bridge/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/jpsoriaga/bridge/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jpsoriaga/bridge/releases/tag/v1.0.0
