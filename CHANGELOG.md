# Changelog

All notable changes to Bridge are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Bridge uses [semantic versioning](https://semver.org/). The desktop app and the extension always share one version.

## [Unreleased]

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

[Unreleased]: https://github.com/jpsoriaga/bridge/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/jpsoriaga/bridge/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jpsoriaga/bridge/releases/tag/v1.0.0
