# Security

Bridge lets a chat running in your browser change files in a folder on your computer and run commands there. That is a lot of reach, so this file says what Bridge protects, from whom, how, and where it stops. [PLAN.md](PLAN.md) has the design detail behind each control.

## What Bridge protects

- **Your files outside the project.** Nothing the chat sends may read, write, delete or rename anything outside the open project folder.
- **Protected files inside it.** `.git/`, `.env`, `.env.*`, keys (`*.pem`, `*.key`, `id_rsa*`), `node_modules/` and your own patterns are never read or written.
- **Your machine.** Only commands you allowlisted run, without a shell, in the project, with a filtered environment. That includes dev servers kept running in the background.
- **Your network.** Nothing the chat sends can make Bridge reach this computer's services or your local network. A download goes out only on your click, to an https address on the internet.
- **The pairing key.** It lets the extension act on the app. It never crosses the wire, and each side keeps it where only your user can read it.
- **Your secrets in what the chat sees.** Likely credentials in command output and file contents are replaced with `[redacted]` before they go into the message box.
- **Your undo.** Every change Bridge makes is backed up first, privately.

## Who it defends against

| Attacker                                                                                                           | What they could try                                                                                                                                         | What stops them                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A malicious web page** in any browser tab                                                                        | Call the local server (`fetch`, a form, a WebSocket), DNS rebinding                                                                                         | Loopback only, `Host` check, `Origin` must be the extension, no CORS, JSON only, mutual HMAC auth                                                                                      |
| **Prompt injection through the chat**: a file, web page or message that makes the model write something harmful    | Paths that climb out (`../`, absolute, symlinks), protected files, commands, flooding requests, downloads from local addresses, disguised or scripted files | The path sandbox, the denylist, gated files, the allowlist and denied options, modes, rate limits, review cards, redaction, click-only https downloads, type sniffing and the SVG scan |
| **Another local process** running as a different user, or one without access to your files that can reach loopback | Squat a Bridge port, impersonate the app or the extension, replay, relay pairing                                                                            | Mutual challenge bound to role, purpose and port; single-use nonces; the pairing fingerprint; private file modes                                                                       |
| **A compromised dependency** (npm package)                                                                         | Run install scripts, ship a vulnerable version                                                                                                              | `onlyBuiltDependencies` (only `electron` and `esbuild` run install scripts), lockfile, `pnpm audit --prod` in CI, Dependabot, actions pinned to commit SHAs                            |

## Controls

### Local server (desktop main process)

- Binds `127.0.0.1` only, on 47821–47830. Rejects any request whose `Host` isn't `127.0.0.1:<port>` (DNS rebinding).
- `/pair`, `/pair/confirm`, `/unpair` and `/ws` require `Origin: chrome-extension://<Bridge's id>`. A web page's origin, no origin and `Origin: null` are all refused (tested).
- No CORS headers, ever. JSON bodies only: a `text/plain` or form POST (a "simple" cross-origin request) gets 415. Bodies are capped at 1 KiB.
- **Socket auth** is a mutual HMAC challenge over the pairing key, bound to role, purpose and port. The app proves itself first, so an impostor learns nothing it can replay. Client nonces are single use (10-minute ledger); server nonces die with their socket. 5 seconds to finish, or the socket closes.
- **Limits:** frames up to 6 MiB + 64 KiB (the largest allowed message: a 1 MB write with JSON's worst-case escaping; binary writes come in 1 MB chunks, so they never need more); at most 2 sockets at once (a third is refused before the upgrade); HTTP requests must arrive within 10 seconds (slowloris); per-operation rates (`read` 50/s, `stat` 100/s, `list` 20/s, `tree` 5/s, `write`/`delete`/`rename`/`undo`/`write_binary`/`read_binary` 10/s, `upload` 30/s, `download` 2/s, `run` and `bg_start` 5/s, `bg_logs` 20/s; one command at a time, three background processes) answered `rate-limited`, and a flood guard that closes a socket past 1,000 messages in 10 seconds; 60 seconds idle closes it. Upload chunks are held in memory only: 2 uploads, 20 MB each, 60 seconds, in order, dropped when their write is refused.
- Every message is a strict zod schema; unknown keys are refused. The one exception is `/health` (`{ name, version, protocol }`), which stays readable across versions; a `hello` in another protocol version is closed with 4009 before anything else is parsed, and both sides say which one to update. Fuzzed with fast-check: random and malformed frames before auth get only `auth_error`, after auth only `error` or a response, and random HTTP bodies only 4xx.

### Pairing

- The app shows a 6-digit code (2 minutes, one use; 5 wrong codes lock pairing for 60 seconds and burn the code).
- The extension sends the code with a one-time P-256 public key; the app answers with its long-lived public key (generated once, stored with `safeStorage`) and a proof. Both derive the pairing key from the ECDH secret and the transcript (port, code, both public keys), and both show a **fingerprint** of that transcript.
- You confirm the fingerprints match in the app, then in the side panel. Only then does either side keep the key. A process squatting a port, or relaying the exchange, changes a public key or the port, so its fingerprint differs from the app's. This closes the trust-on-first-use gap earlier versions had.
- The app keeps the key encrypted with `safeStorage` (plain hex in a `0600` file if no keyring is available); the extension keeps it in its service worker's IndexedDB, which content scripts can't open.

### Files (path sandbox)

- Every path from the chat is checked lexically (NFC; no absolute paths, drive letters, UNC, backslashes, `:`, NUL or control characters, empty, `.` or `..` segments, trailing dots or spaces, Windows device names), then walked one component at a time with `lstat` and `realpath` from the real project root. A symlink must land inside the root and off the denylist; dangling links, sockets, FIFOs and devices are refused.
- **Hard links:** a file with more than one link could be a file outside the project, so reading, hashing, modifying, deleting or renaming one is refused (`hardlink`).
- **Race re-check:** right before every commit (the final rename or link of a write, a delete, both sides of a rename, an undo), the target folder's real path is checked again and the change is aborted if it moved outside the project. Opens use `O_NOFOLLOW` where the platform has it.
- Writes go to a temp file, are fsynced, then moved into place (atomic). Creates never replace a file that appeared meanwhile. Modifies need the hash the card saw (`conflict` otherwise).
- Deletes and renames need a click, in every mode, unless you turn on Full auto → **Also approve automatically → Deletes and renames**.
- **Gated files** (`package.json`, lockfiles, `.npmrc`, CI workflows, git hooks, `Dockerfile`, `Makefile`, …) are never written automatically, unless you turn on Full auto → **Also approve automatically → Gated files**. The app enforces both settings itself; the extension can't claim them. Turning either on asks in a native dialog the window can't skip, and everything done that way is backed up and labelled "auto-approved" in Activity.
- **Never automatic, whatever the settings:** commands off the allowlist, downloads, protected files and files that changed on disk.
- **Binary files** (images the chat made, downloads) go through the same sandbox, denylist, gated files, backups and undo as text, up to 20 MB, and only as a type Bridge saves: png, jpg, webp, gif, svg, ico, avif, woff, woff2, ttf, otf, mp3, wav, mp4, webm, json or txt. The type is read from the bytes, and must be the one the file name says: a `.png` that's really a web page, or a program under any name, is refused. An SVG with a `<script>`, an event handler (`onload=`), a `javascript:` link, embedded HTML or an XML entity is refused (character references decoded first).
- Backups, the operation log, settings and the keys live in userData: `0700` folders and `0600` files on POSIX, checked and tightened at every start.

### Commands

- `spawn` with `shell: false`, never a shell string. The chat's text becomes argv with shell-quote's tokenizer after refusing `$`, backticks, globs, operators, comments, `VAR=value` and newlines; the app re-checks every word.
- **Allowlist entries match exactly.** `pnpm test` allows only `pnpm test`; `pnpm test *` allows extra arguments after it. (Entries saved before Phase 7 got a `*`, since that's how they behaved, and Settings says so once.)
- **The install command** (`npm install`, `pnpm install`, `yarn install` or `bun install`, picked from the lockfile) is suggested, pre-ticked, when a project's list is first confirmed, as an exact entry with no `*`. It installs only what `package.json` lists: `npm install lodash`, `npm i <pkg>`, `npm install --global`, `npx`, `dlx` and `npm create` are all still refused (not allowlisted, or denied options). The chat can only change what it installs by editing `package.json` or a lockfile, which are gated: never written without your click, in any mode. Lists confirmed before 1.1.0 get a one-time note offering to add it; it's never added on its own.
- **Denied options**, refused even under `*`: `git --output -o -c --config-env --exec --upload-pack --receive-pack -C --git-dir --work-tree`; `node -e --eval -p --print -r --require --import --loader --experimental-loader`; `npm`/`pnpm`/`yarn` `-C --dir --prefix --global -g exec dlx x` (and yarn `--cwd`); `npx`, `pnpx` and `bunx` entirely. Abbreviations (`--outp`), attached values (`-Cdir`) and clusters (`-pe`) count. One table: `DENIED_FLAGS` in `packages/shared/src/commands.ts`.
- A program that resolves inside the project is refused unless that exact path is allowlisted. Windows `.cmd` shims go through cross-spawn's escaping, and cmd metacharacters are refused in their arguments.
- Environment: your variables minus `*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `AWS_*`, `OPENAI_*`, `GITHUB_TOKEN`, `NPM_TOKEN`, `ELECTRON_RUN_AS_NODE` and your own patterns.
- Timeout (2 minutes by default; 5 minutes for the install command, set separately) kills the whole process tree. Output is capped at 200 KB, head and tail, and a command that prints without end is throttled by backpressure so it can't stall the app.
- **Background processes** (dev servers) are allowlist entries you mark **Background** in Settings → Commands (a dev, start, serve, preview or watch script starts out marked). They pass every check above, start only with `@@START` (never `@@RUN`, and a one-off never with `@@START`), have no timeout, and at most three run at once. A second `@@START` restarts the one that's running. Stop kills the whole process tree, and everything stops when the session ends, the project switches, the app quits (it waits until they're gone) or the computer sleeps more than 30 minutes. They keep their last 2,000 lines, each redacted as it arrives. The app opens only the local `http(s)://localhost` address a process printed itself.

### Secret redaction

Before command output or file contents go into the chat: `sk-…`, GitHub (`ghp_…`, `gho_…`, `github_pat_…`), AWS (`AKIA…`, `ASIA…`), Slack (`xoxb-…`, `xoxp-…`), JWTs, PEM blocks, `Bearer` tokens, and high-entropy values next to words like `key`, `token`, `secret` or `password` become `[redacted]`. Cards and the side panel show how many. Full auto still sends, and logs the count. Patterns and their false-positive cases are in `packages/shared/src/redact.ts` and its tests.

### Downloads

- `@@DOWNLOAD https://… -> path` downloads only when you click **Download** on its card, in every mode: the extension never asks for an automatic one and the app refuses one, whatever "Also approve automatically" says. Full auto pauses until you click.
- The **app** fetches it (the extension's permissions don't change): https only, every redirect too (at most 5); no user name or password in the URL; never this computer or the local network, by name (`localhost`, `*.local`, single-word names) or by address (loopback, private and link-local ranges, carrier-grade NAT, multicast, unique-local IPv6, IPv4 inside IPv6), checked on the address the connection itself resolves, so DNS rebinding can't get round it; 20 MB at most, stopped as soon as it's over; 60 seconds. It sends no cookies or referrer.
- The path is checked by the sandbox before any request, and the bytes by the type and SVG checks above before anything is written.
- **Download from URL** on a Save to project card (an image the chat made that the page won't let the extension read) is the same request: the image's own https address, sent by the worker as a click like any DOWNLOAD card, with every check above. It appears only after a save failed for that reason, and nothing automatic uses it.

### Desktop app (Electron)

- `app.enableSandbox()`; windows run with `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`.
- Every permission request and check is refused. Every web contents has `will-navigate`, `will-redirect` and `will-attach-webview` blocked and new windows denied (https links open in your browser).
- CSP `default-src 'none'; script-src 'self'; style-src 'self'; …` with no `unsafe-*`, tested on the built `index.html`.
- Preload exposes one typed object. Every IPC handler checks the call comes from the app window's top frame and validates its arguments with a zod schema per channel. No handler takes a filesystem path.
- Fuses (applied at packaging, `apps/desktop/scripts/fuses.cjs`; check a build with `pnpm --filter @bridge/desktop verify:fuses <app>`): RunAsNode off, NODE_OPTIONS off, `--inspect` off, embedded asar integrity on, only load from asar on, cookie encryption on. The release workflow verifies them on every packaged app and fails the release if any is wrong.
- **Packaging.** `app.asar` holds only the built app and its production dependencies; `check:package` lists it and fails on source, tests, source maps, TypeScript, e2e, fixtures, `archive/`, dev dependencies or secret-looking files. Its hash is embedded in the app and checked at launch (the asar integrity fuse). Signed macOS builds use hardened runtime with one entitlement, `allow-jit` (V8); unsigned macOS builds are ad-hoc signed. Each packaged app is launched in CI and must open its window and answer `/health` on `127.0.0.1`.

### Extension

- Permissions: `storage`, `sidePanel`, `alarms`, and host access to `http://127.0.0.1/*` only. The content script runs only on `https://chatgpt.com/*`, top frame. No `<all_urls>`, no optional permissions. 1.3.0 added none: an image the chat made is read from the page itself (its own URL on chatgpt.com, a `blob:` or `data:` URL, or the loaded image drawn to a canvas), and downloads are fetched by the app.
- Attaching an image sets the files of the chat's own file input (or pastes them), as picking them in the file dialog would; it never presses send outside Full auto.
- Extension pages run under `script-src 'self'; object-src 'none'; base-uri 'none'`. `externally_connectable` is empty: no page or other extension can message Bridge.
- Every `chrome.runtime` listener checks the sender and parses with zod. The worker accepts chat requests only from frame 0 of an `https://chatgpt.com` tab, and file requests only while that tab has an active session.
- `chrome.storage.local` (which content scripts can read) holds only paths, hashes, counts, states and the port: never file contents, output or the key.
- Cards live in closed shadow roots and are built from text nodes; nothing from the chat goes through `innerHTML`.

### Privacy

No telemetry, no analytics, no network calls except loopback between the extension and the app, with two exceptions the user controls. A `@@DOWNLOAD` is fetched by the app only when you click **Download** on its card (see "Downloads"). And **Check for updates** (Settings → About) asks GitHub Releases for the latest version number, on a click or, if the user turns it on, once at launch (off by default). It sends nothing about the user, downloads and installs nothing (`autoDownload` and `autoInstallOnAppQuit` off; electron-updater is loaded only when a check runs), and is off in unsigned macOS builds. The **Beta** update channel (Settings → About; beta builds start on it) only lets that same request read pre-releases; the **Stable** channel never shows a beta, and betas are never marked Latest. The extension's only requests off loopback are to chatgpt.com itself, when you save an image the chat made (or Full auto does): it reads that image from the page, from the browser's cache where it can. [PRIVACY.md](PRIVACY.md) lists what's stored where.

**Logs and diagnostics.** The app logs events to `userData/logs/bridge.log` (`0700` folder, `0600` files, rotated at 5 MB, 3 files at most): never file contents, command output, pairing codes, keys or tokens, and every line goes through `logLine` (shared): one line, capped at 500 characters, the home folder as `~`, `redactSecrets`, and any 32+ character hex or random-looking run (keys, proofs, hashes) as `[redacted]`. The extension's worker keeps its recent events in memory only, never in `chrome.storage`. **Copy diagnostics** (app Help menu and Settings → About; side panel) builds a block of versions, system, browser, mode, connection state and the last 50 log lines, and runs the whole block through the same redaction before it reaches the clipboard. Nothing is sent anywhere.

### Releases

- Built by GitHub Actions from a version tag only, after the full check suite; the result is a **draft** release the maintainer publishes by hand, with `SHA256SUMS.txt`. A `vX.Y.Z-beta.N` tag makes a pre-release that is never marked Latest and carries only the Load unpacked extension zip (no store upload).
- Signing secrets are repository secrets passed as environment variables to the packaging step of their own platform, never to CI, pull requests or the release job, and never printed. A partial set of a platform's secrets fails the build instead of shipping unsigned by mistake.
- Every job has a read-only token except the last, which may only create the release. Actions are pinned to commit SHAs.
- The store build of the extension has no manifest `key` (the store assigns the ID); the app accepts the development ID and, once set, `STORE_EXTENSION_ID`, both checked to be well-formed IDs.

## Known limits

These are real, and Bridge can't close them:

- **Tests run code the model wrote.** Allowlisting `pnpm test` means running test files and config (`vitest.config.ts`, `conftest.py`) the chat may have edited. Gated files cover installs, scripts and CI, not test code. Full auto runs that code without a click. Review what the chat changes before you run it, or keep to Manual. A dev server is the same: it serves and hot-reloads the code the chat writes, and keeps running between messages.
- **"Also approve automatically" removes a review.** With gated files on, Full auto can change `package.json` and then run the install command, which installs and runs whatever packages it lists. With deletes and renames on, it can remove files. Backups and Undo bring files back, not what a command did meanwhile. Each setting is off by default and says so when you turn it on.
- **Downloads come from the internet.** Bridge checks the type and refuses scripted SVGs, but a file can still be harmful in other ways (a font or image that exploits a viewer). Downloads always wait for your click; look at the URL first.
- **The install command runs install scripts.** `npm install` (and the others) runs the install scripts of every dependency in `package.json`, with your permissions, and in Full auto without a click. Bridge only makes sure the list of dependencies is one you approved: a `package.json` or lockfile change always waits for your click. Review those diffs as you would any new dependency, or leave the install command off the allowlist.
- **Allowlisted programs can do more than their name suggests.** The denied-options table covers the well-known escape hatches of git, node and the package managers, not every program or every option. A `*` entry passes whatever arguments the chat chooses; prefer exact entries.
- **Local malware running as you** can read your files, Bridge's keys and backups, and drive Chrome or the app directly. Bridge narrows races (symlink swaps between check and write) but does not defend against code that already has your user's rights.
- **Redaction is best effort.** It catches common credential shapes, not every secret. Don't keep secrets in files you send to the chat; keep them in `.env` files, which Bridge never reads.
- **Prompt injection can still steer edits inside the project.** The sandbox stops it reaching outside the folder and protected files; it can't tell a malicious edit to your own code from a good one. That's what the diff cards and Undo are for.
- **The chat provider sees what you send.** File contents and command output go to the chat service you use, under its terms.
- **The fingerprint only helps if you compare it.** Confirming without looking brings back the trust-on-first-use gap.
- **Unsigned builds prove nothing about who made them.** Until releases are signed, `SHA256SUMS.txt` only shows a download matches what the release page lists; it comes from the same place. The AppImage is never signed. Get Bridge only from the repository's releases page.
- **Platform gaps:** `O_NOFOLLOW` and file modes don't exist on Windows (ACLs on the profile folder apply instead). Without a keyring on Linux, keys are stored as plain hex in `0600` files.

## Reporting a problem

Bridge is a personal project. If you find a security issue, please don't open a public issue. Report it privately through the repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting), with what you found, how to reproduce it, and which version or commit you tested. Expect an answer within a week. There's no bounty.
