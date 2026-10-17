# End-to-end scripts

Manual Playwright scripts that drive the **built** desktop app and a headless Chrome for Testing with the unpacked extension. They are not part of the pnpm workspace and don't run in CI yet.

## Setup

```bash
pnpm build                                  # apps/desktop/out and apps/extension/dist
npm install --prefix e2e                    # playwright-core only, outside the workspace
npx --prefix e2e playwright-core install chromium
```

Set `CHROMIUM_PATH` to use a different Chromium binary. Each run uses fresh temp directories for the app's userData and the Chrome profile, so it never touches your real pairing.

If your shell sets `ELECTRON_RUN_AS_NODE=1`, the scripts unset it for the app they launch.

## Scripts

| Command                | What it checks                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node e2e/run.cjs .`   | Wrong then right pairing code, `tokenHash`-only storage, encrypted `pairing.json`, unpair from either side, app quit and relaunch (alarm set, then cleared), 5-wrong-code lockout |
| `node e2e/probe.cjs .` | Which loopback calls the worker can make with and without `host_permissions` (the Phase 2 decision in PLAN.md)                                                                    |

The argument is the repo root. Each script prints one line per step and ends with `E2E OK` or exits non-zero.

Ports 47821–47830 must be free of other Bridge instances while a script runs.
