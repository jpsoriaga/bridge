# Security

Bridge lets a chat running in your browser change files in a folder on your computer and run commands there. That is a lot of reach, so this file says what Bridge protects, from whom, how, and where it stops. [PLAN.md](PLAN.md) has the design detail behind each control.

## What Bridge protects

- **Your files outside the project.** Nothing the chat sends may read, write, delete or rename anything outside the open project folder.
- **Protected files inside it.** `.git/`, `.env`, `.env.*`, keys (`*.pem`, `*.key`, `id_rsa*`), `node_modules/` and your own patterns are never read or written.
- **Your machine.** Only commands you allowlisted run, without a shell, in the project, with a filtered environment.
- **The pairing key.** It lets the extension act on the app. It never crosses the wire, and each side keeps it where only your user can read it.
- **Your secrets in what the chat sees.** Likely credentials in command output and file contents are replaced with `[redacted]` before they go into the message box.
- **Your undo.** Every change Bridge makes is backed up first, privately.

## Who it defends against

| Attacker                                                                                                           | What they could try                                                                            | What stops them                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A malicious web page** in any browser tab                                                                        | Call the local server (`fetch`, a form, a WebSocket), DNS rebinding                            | Loopback only, `Host` check, `Origin` must be the extension, no CORS, JSON only, mutual HMAC auth                                                           |
| **Prompt injection through the chat**: a file, web page or message that makes the model write something harmful    | Paths that climb out (`../`, absolute, symlinks), protected files, commands, flooding requests | The path sandbox, the denylist, gated files, the allowlist and denied options, modes, rate limits, review cards, redaction                                  |
| **Another local process** running as a different user, or one without access to your files that can reach loopback | Squat a Bridge port, impersonate the app or the extension, replay, relay pairing               | Mutual challenge bound to role, purpose and port; single-use nonces; the pairing fingerprint; private file modes                                            |
| **A compromised dependency** (npm package)                                                                         | Run install scripts, ship a vulnerable version                                                 | `onlyBuiltDependencies` (only `electron` and `esbuild` run install scripts), lockfile, `pnpm audit --prod` in CI, Dependabot, actions pinned to commit SHAs |

## Controls

### Local server (desktop main process)

- Binds `127.0.0.1` only, on 47821–47830. Rejects any request whose `Host` isn't `127.0.0.1:<port>` (DNS rebinding).
- `/pair`, `/pair/confirm`, `/unpair` and `/ws` require `Origin: chrome-extension://<Bridge's id>`. A web page's origin, no origin and `Origin: null` are all refused (tested).
- No CORS headers, ever. JSON bodies only: a `text/plain` or form POST (a "simple" cross-origin request) gets 415. Bodies are capped at 1 KiB.
- **Socket auth** is a mutual HMAC challenge over the pairing key, bound to role, purpose and port. The app proves itself first, so an impostor learns nothing it can replay. Client nonces are single use (10-minute ledger); server nonces die with their socket. 5 seconds to finish, or the socket closes.
- **Limits:** frames up to 6 MiB + 64 KiB (the largest allowed message: a 1 MB write with JSON's worst-case escaping); at most 2 sockets at once (a third is refused before the upgrade); HTTP requests must arrive within 10 seconds (slowloris); per-operation rates (`read` 50/s, `stat` 100/s, `list` 20/s, `tree` 5/s, `write`/`delete`/`rename`/`undo` 10/s, `run` 5/s and one at a time) answered `rate-limited`, and a flood guard that closes a socket past 1,000 messages in 10 seconds; 60 seconds idle closes it.
- Every message is a strict zod schema; unknown keys are refused. Fuzzed with fast-check: random and malformed frames before auth get only `auth_error`, after auth only `error` or a response, and random HTTP bodies only 4xx.

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
- Deletes and renames always need a click, in every mode.
- **Gated files** (`package.json`, lockfiles, `.npmrc`, CI workflows, git hooks, `Dockerfile`, `Makefile`, …) are never written automatically.
- Backups, the operation log, settings and the keys live in userData: `0700` folders and `0600` files on POSIX, checked and tightened at every start.

### Commands

- `spawn` with `shell: false`, never a shell string. The chat's text becomes argv with shell-quote's tokenizer after refusing `$`, backticks, globs, operators, comments, `VAR=value` and newlines; the app re-checks every word.
- **Allowlist entries match exactly.** `pnpm test` allows only `pnpm test`; `pnpm test *` allows extra arguments after it. (Entries saved before Phase 7 got a `*`, since that's how they behaved, and Settings says so once.)
- **Denied options**, refused even under `*`: `git --output -o -c --config-env --exec --upload-pack --receive-pack -C --git-dir --work-tree`; `node -e --eval -p --print -r --require --import --loader --experimental-loader`; `npm`/`pnpm`/`yarn` `-C --dir --prefix --global -g exec dlx x` (and yarn `--cwd`); `npx`, `pnpx` and `bunx` entirely. Abbreviations (`--outp`), attached values (`-Cdir`) and clusters (`-pe`) count. One table: `DENIED_FLAGS` in `packages/shared/src/commands.ts`.
- A program that resolves inside the project is refused unless that exact path is allowlisted. Windows `.cmd` shims go through cross-spawn's escaping, and cmd metacharacters are refused in their arguments.
- Environment: your variables minus `*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `AWS_*`, `OPENAI_*`, `GITHUB_TOKEN`, `NPM_TOKEN`, `ELECTRON_RUN_AS_NODE` and your own patterns.
- Timeout (2 minutes by default) kills the whole process tree. Output is capped at 200 KB, head and tail, and a command that prints without end is throttled by backpressure so it can't stall the app.

### Secret redaction

Before command output or file contents go into the chat: `sk-…`, GitHub (`ghp_…`, `gho_…`, `github_pat_…`), AWS (`AKIA…`, `ASIA…`), Slack (`xoxb-…`, `xoxp-…`), JWTs, PEM blocks, `Bearer` tokens, and high-entropy values next to words like `key`, `token`, `secret` or `password` become `[redacted]`. Cards and the side panel show how many. Full auto still sends, and logs the count. Patterns and their false-positive cases are in `packages/shared/src/redact.ts` and its tests.

### Desktop app (Electron)

- `app.enableSandbox()`; windows run with `contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`.
- Every permission request and check is refused. Every web contents has `will-navigate`, `will-redirect` and `will-attach-webview` blocked and new windows denied (https links open in your browser).
- CSP `default-src 'none'; script-src 'self'; style-src 'self'; …` with no `unsafe-*`, tested on the built `index.html`.
- Preload exposes one typed object. Every IPC handler checks the call comes from the app window's top frame and validates its arguments with a zod schema per channel. No handler takes a filesystem path.
- Fuses (applied at packaging, `apps/desktop/scripts/fuses.cjs`; check a build with `pnpm --filter @bridge/desktop verify:fuses <app>`): RunAsNode off, NODE_OPTIONS off, `--inspect` off, embedded asar integrity on, only load from asar on, cookie encryption on.

### Extension

- Permissions: `storage`, `sidePanel`, `alarms`, and host access to `http://127.0.0.1/*` only. The content script runs only on `https://chatgpt.com/*`, top frame. No `<all_urls>`, no optional permissions.
- Extension pages run under `script-src 'self'; object-src 'none'; base-uri 'none'`. `externally_connectable` is empty: no page or other extension can message Bridge.
- Every `chrome.runtime` listener checks the sender and parses with zod. The worker accepts chat requests only from frame 0 of an `https://chatgpt.com` tab, and file requests only while that tab has an active session.
- `chrome.storage.local` (which content scripts can read) holds only paths, hashes, counts, states and the port: never file contents, output or the key.
- Cards live in closed shadow roots and are built from text nodes; nothing from the chat goes through `innerHTML`.

### Privacy

No telemetry, no analytics, no network calls except loopback between the extension and the app.

## Known limits

These are real, and Bridge can't close them:

- **Tests run code the model wrote.** Allowlisting `pnpm test` means running test files and config (`vitest.config.ts`, `conftest.py`) the chat may have edited. Gated files cover installs, scripts and CI, not test code. Full auto runs that code without a click. Review what the chat changes before you run it, or keep to Manual.
- **Allowlisted programs can do more than their name suggests.** The denied-options table covers the well-known escape hatches of git, node and the package managers, not every program or every option. A `*` entry passes whatever arguments the chat chooses; prefer exact entries.
- **Local malware running as you** can read your files, Bridge's keys and backups, and drive Chrome or the app directly. Bridge narrows races (symlink swaps between check and write) but does not defend against code that already has your user's rights.
- **Redaction is best effort.** It catches common credential shapes, not every secret. Don't keep secrets in files you send to the chat; keep them in `.env` files, which Bridge never reads.
- **Prompt injection can still steer edits inside the project.** The sandbox stops it reaching outside the folder and protected files; it can't tell a malicious edit to your own code from a good one. That's what the diff cards and Undo are for.
- **The chat provider sees what you send.** File contents and command output go to the chat service you use, under its terms.
- **The fingerprint only helps if you compare it.** Confirming without looking brings back the trust-on-first-use gap.
- **Platform gaps:** `O_NOFOLLOW` and file modes don't exist on Windows (ACLs on the profile folder apply instead). Without a keyring on Linux, keys are stored as plain hex in `0600` files.

## Reporting a problem

Bridge is a personal project. If you find a security issue, please don't open a public issue. Report it privately through the repository's **Security → Report a vulnerability** (GitHub private vulnerability reporting), with what you found, how to reproduce it, and which version or commit you tested. Expect an answer within a week. There's no bounty.
