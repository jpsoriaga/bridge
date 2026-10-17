# CLAUDE.md

Bridge lets the ChatGPT web chat edit a local project. A Chrome MV3 extension on chatgpt.com parses `@@FILE` blocks and shows diff cards. An Electron desktop app writes the files inside a sandboxed project root, connected over loopback. Personal project.

**Before any task, read PLAN.md, CHECKLIST.md and DESIGN.md. When you finish one, tick it in CHECKLIST.md.** Work only on the current phase.

## Stack

pnpm workspaces · TypeScript (strict) · Electron + electron-vite + React · Chrome MV3 via CRXJS + Vite + React · Vitest · ESLint 10 (flat) + Prettier · Geist / Geist Mono

## Layout

- `apps/desktop`: `src/main` (Node, the only code that touches disk or spawns), `src/preload` (`window.bridge`), `src/renderer` (React)
- `apps/extension`: `manifest.config.ts`, `src/content` (chatgpt.com), `src/background` (service worker), `src/sidepanel` (React)
- `packages/shared`: `@bridge/shared` TS source (types, chat parser and prompts, diff helper, logo geometry, `tokens.css` + `styles.css`). No build step
- `archive/prototype`: old prototype, reference only. Not built or linted. Don't import from it

## Commands

```bash
pnpm dev          # desktop + extension watch
pnpm build        # both apps
pnpm lint         # eslint .
pnpm typecheck    # tsc in every package
pnpm test         # vitest
pnpm format       # prettier --write .
```

Before saying a task is done, run lint, typecheck, test and build.
If `pnpm dev` fails with `electron.app` undefined, the shell has `ELECTRON_RUN_AS_NODE=1`. Use `env -u ELECTRON_RUN_AS_NODE pnpm dev`.

## Conventions

- Strict TS. No `any`; if one is truly unavoidable, add a comment saying why.
- Types and protocol shared by more than one app live in `@bridge/shared`. App-only types stay in the app.
- Match the surrounding style. Prettier decides formatting (single quotes, no trailing commas, width 100).
- UI uses tokens from `@bridge/shared/styles.css` only. No raw hex in components. Follow DESIGN.md.
- No new dependency without a clear need. Remove deps you stop using.

## Security rules (never break these)

1. The local server binds **127.0.0.1 only**, checks `Origin`, and requires the pairing token.
2. **Path sandbox** on every chat-supplied path: no absolute paths, no `..`, no symlinks that resolve outside the root, nothing under `.git`, no `.env*` files.
3. Commands use **`spawn` with `shell: false`** and an exact-argv **allowlist**. Never build a shell string.
4. Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP. Preload exposes only narrow, typed, validated methods.
5. **No telemetry**, analytics or non-loopback network calls.
6. **No Codex or OpenAI branding** in names, UI, icons or copy. Say "the chat".
7. Extension permissions stay minimal: chatgpt.com only, no `<all_urls>`.
