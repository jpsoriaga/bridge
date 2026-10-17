# Bridge

> Production-grade developer tool for synchronizing AI-generated code blocks directly into local workspaces with zero friction and strict security.

---

## Overview

**Bridge** connects your browser AI conversations (ChatGPT, Claude, Gemini, etc.) directly to your local codebase. It eliminates manual copying, pasting, and saving of multiple files by parsing structured `@@FILE` change blocks and securely relaying them to a companion desktop application.

### Key Highlights
- **Production Monorepo**: Managed with `pnpm` workspaces, strict TypeScript configurations, and shared schemas.
- **Hardened Electron Desktop**: Isolated main process, context-isolated preload script, and Fastify server strictly bound to loopback `127.0.0.1`.
- **Manifest V3 Chrome Extension**: Built with React and CRXJS, keeping permissions minimal and delegating all filesystem writes to the desktop app.
- **Security-First Architecture**: Path traversal prevention, symlink escape checks, timing-safe token authentication, and command execution allowlisting.
- **Rollback / Undo Support**: Automatic state preservation enabling one-click transaction rollbacks.

---

## Monorepo Architecture

```text
bridge/
├── apps/
│   ├── desktop/      # Electron + React + Vite + Fastify Desktop App
│   └── extension/    # Chrome Extension (Manifest V3 + React + CRXJS)
├── packages/
│   └── shared/       # Shared Parser, Protocol, Zod Schemas & Types
├── docs/             # Technical Architecture, Protocol, and Security Docs
└── scripts/          # Automated verification and build utilities
```

---

## Prerequisites

- **Node.js**: `v20.0.0` or higher (`v24.x` recommended)
- **pnpm**: `v9.0.0` or higher (via Corepack)
- **Google Chrome** (or Chromium-based browser)

---

## Quick Start

### 1. Enable pnpm and Install Dependencies
```bash
# Enable pnpm via corepack if not already installed
corepack enable

# Install workspace dependencies
pnpm install
```

### 2. Verify TypeScript and Builds
```bash
# Typecheck all packages
pnpm run typecheck

# Build all packages and applications
pnpm run build
```

---

## Development Commands

| Command | Description |
| :--- | :--- |
| `pnpm run dev` | Starts the Desktop Electron application in development mode with HMR |
| `pnpm run dev:desktop` | Alias for `pnpm run dev` |
| `pnpm run dev:extension` | Starts the Chrome extension Vite build with CRXJS hot-reloading |
| `pnpm run typecheck` | Typechecks shared package, desktop main/renderer, and extension |
| `pnpm run build` | Compiles `@bridge/shared`, builds desktop app, and bundles extension |
| `pnpm run package:mac` | Packages desktop application into a macOS `.dmg` installer |
| `pnpm run package:win` | Packages desktop application into a Windows `.exe` installer |
| `./scripts/verify.sh` | Local verification script checking typechecking and builds |

---

## Loading the Extension into Chrome

1. Build or run the extension in dev mode:
   ```bash
   pnpm run build:extension
   # or for live development:
   pnpm run dev:extension
   ```
2. Navigate to `chrome://extensions/` in Google Chrome.
3. Enable **Developer mode** (toggle in upper right).
4. Click **Load unpacked** and select `apps/extension/dist/`.
5. Open the Extension Options and pair with Bridge Desktop.

---

## Documentation

Comprehensive architectural and engineering documentation is available in the [`docs/`](./docs/README.md) directory:

- [Architecture Overview](./docs/ARCHITECTURE.md) — End-to-end data flow, trust boundaries, and component roles.
- [Folder Structure & Conventions](./docs/FOLDER-STRUCTURE.md) — Code placement rules, import boundaries, and naming standards.
- [Development Guide](./docs/DEVELOPMENT.md) — Setup details, dependency management, and troubleshooting.
- [Security Architecture](./docs/SECURITY.md) — Threat model, loopback restrictions, path traversal defenses, and command allowlisting.
- [Communication Protocol](./docs/COMMUNICATION-PROTOCOL.md) — Envelope structure, versioning, and API endpoints.
- [Packaging & Distribution](./docs/PACKAGING.md) — macOS DMG and Windows NSIS installer creation with code signing notes.
