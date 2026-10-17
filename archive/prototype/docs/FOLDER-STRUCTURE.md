# Bridge Folder Structure & Code Organization

This document outlines the directory structure, code placement conventions, and import boundaries of the Bridge monorepo.

---

## 1. Monorepo Directory Tree

```text
bridge/
├── .github/
│   └── workflows/
│       └── ci.yml               # Multi-platform CI pipeline (Linux, macOS, Windows)
├── apps/
│   ├── desktop/                 # Electron desktop application
│   │   ├── out/                 # Build artifacts for main, preload, and renderer
│   │   ├── resources/           # App icons, macOS entitlements, packaging assets
│   │   ├── src/
│   │   │   ├── main/            # Electron main process (Node.js environment)
│   │   │   │   ├── commands/    # Controlled shell command execution & allowlist
│   │   │   │   ├── filesystem/  # Workspace file operations, containment & checks
│   │   │   │   ├── history/     # Undo transaction stack & rollback manager
│   │   │   │   ├── ipc/         # IPC channel handlers (dialogs, workspace, undo)
│   │   │   │   ├── server/      # Fastify 127.0.0.1 loopback HTTP server & routes
│   │   │   │   ├── services/    # Security token, configuration, and state services
│   │   │   │   └── index.ts     # Main process entry point & window manager
│   │   │   ├── preload/         # Secure contextBridge IPC layer
│   │   │   │   ├── index.ts     # Preload bridge exposing window.bridgeApi
│   │   │   │   └── index.d.ts   # Global type declaration for Window.bridgeApi
│   │   │   └── renderer/        # React frontend UI (Browser DOM environment)
│   │   │       ├── index.html   # Main HTML template with strict CSP
│   │   │       └── src/
│   │   │           ├── app/     # App root and React DOM entry points
│   │   │           ├── components/ # Presentation components (DiffViewer, Logs, etc.)
│   │   │           ├── features/   # Domain-specific feature modules
│   │   │           ├── hooks/      # React hooks (e.g., useBridgeIpc)
│   │   │           ├── lib/        # Utility helpers and UI formatters
│   │   │           ├── services/   # Client-side services
│   │   │           ├── stores/     # Client state stores
│   │   │           ├── styles/     # CSS styles and design tokens
│   │   │           └── types/      # Renderer-specific TypeScript declarations
│   │   ├── electron-builder.yml # Packaging configuration for macOS DMG & Windows NSIS
│   │   ├── electron.vite.config.ts # Vite configuration for main/preload/renderer
│   │   ├── package.json
│   │   ├── tsconfig.json        # Project references
│   │   ├── tsconfig.node.json   # TS config for main and preload (Node runtime)
│   │   └── tsconfig.web.json    # TS config for renderer (DOM/React runtime)
│   └── extension/               # Chrome Extension (Manifest V3)
│       ├── dist/                # Bundled extension ready to unpack in Chrome
│       ├── public/
│       │   └── manifest.json    # Chrome Manifest V3 configuration
│       ├── src/
│       │   ├── background/      # Extension service worker (lifecycle & relay)
│       │   ├── components/      # React components (StatusBadge, FileCard)
│       │   ├── content/         # Content script injected into AI chat tabs
│       │   ├── lib/             # Formatting and path utilities
│       │   ├── options/         # Extension configuration settings page
│       │   ├── popup/           # Browser action popup UI
│       │   └── services/        # BridgeClient (HTTP relay) & storage service
│       ├── package.json
│       ├── tsconfig.json        # Extension TypeScript configuration
│       └── vite.config.ts       # CRXJS Vite build configuration
├── docs/                        # Complete technical documentation suite
│   ├── ARCHITECTURE.md
│   ├── COMMUNICATION-PROTOCOL.md
│   ├── DEVELOPMENT.md
│   ├── FOLDER-STRUCTURE.md
│   ├── PACKAGING.md
│   ├── README.md
│   └── SECURITY.md
├── packages/
│   └── shared/                  # Shared TypeScript package (@bridge/shared)
│       ├── dist/                # Compiled declaration files and bundles
│       ├── src/
│       │   ├── parser/          # @@FILE block parser with safety validation
│       │   ├── protocol/        # Versioning constants & event definitions
│       │   ├── schemas/         # Zod schemas for path traversal and payloads
│       │   ├── types/           # Core domain interfaces (diff, message, session)
│       │   └── index.ts         # Public package exports
│       ├── package.json
│       └── tsconfig.json
├── scripts/
│   └── verify.sh                # Local typecheck and build verification script
├── .gitignore
├── .npmrc                       # pnpm hoisting and workspace resolution rules
├── package.json                 # Monorepo root scripts & packageManager definition
├── pnpm-workspace.yaml          # Monorepo workspace membership
├── tsconfig.base.json           # Shared base TypeScript configuration
└── README.md                    # Project README and quick start
```

---

## 2. Directory Responsibilities & Code Placement Guidelines

### 2.1 Where should new code go?

| Code Type | Target Location | Rationale |
| :--- | :--- | :--- |
| **New UI Component (Desktop)** | `apps/desktop/src/renderer/src/components/` | Self-contained React component presentation. |
| **Desktop Page / Feature Module** | `apps/desktop/src/renderer/src/features/<feature-name>/` | Encapsulates related components, hooks, and local types. |
| **New IPC Handler** | `apps/desktop/src/main/ipc/handlers.ts` | Registered in Electron main; exposed via preload. |
| **New Preload API Method** | `apps/desktop/src/preload/index.ts` & `index.d.ts` | Context isolation bridge with explicit type definition. |
| **Main Process Service** | `apps/desktop/src/main/services/` | Node.js backend logic, state management, or system integration. |
| **File / Disk Operations** | `apps/desktop/src/main/filesystem/` | Keep disk manipulation centralized so security validation cannot be bypassed. |
| **New Command Allowlist Entry** | `apps/desktop/src/main/commands/allowlist.ts` | Controlled shell execution permissions. |
| **Extension Content Script Logic** | `apps/extension/src/content/` | DOM queries and chat element scanning in browser tabs. |
| **Extension Options UI** | `apps/extension/src/options/` | User settings, credential inputs, and pairing testing. |
| **Shared Data Type or Interface** | `packages/shared/src/types/` | Cross-package types shared between extension and desktop. |
| **Validation Schema** | `packages/shared/src/schemas/` | Zod schemas ensuring runtime safety across boundaries. |
| **Parser Logic** | `packages/shared/src/parser/` | Chat text syntax parsing with path safety verification. |

---

## 3. Import Boundaries and Rules

To prevent accidental coupling and security regressions:

1. **`@bridge/shared` is pure and environment-agnostic**:
   - MUST NOT import from `electron`, `fs`, `path`, or `chrome`.
   - Uses standard Web APIs (`crypto.randomUUID()`) or platform-independent libraries (`zod`).
   - Can be safely imported by browser extensions, Node.js main processes, and React renderers.

2. **Electron Renderer isolation**:
   - MUST NOT import `electron`, `fs`, `child_process`, or Node.js built-ins.
   - All desktop system communication must proceed through `window.bridgeApi`.
   - TypeScript compiler prevents Node imports via `tsconfig.web.json`.

3. **Chrome Extension isolation**:
   - MUST NOT attempt to use Node.js modules or native desktop paths.
   - Relies exclusively on Chrome Extension APIs (`chrome.storage`, `chrome.runtime`) and fetch requests to `http://127.0.0.1:<port>`.

4. **Electron Main isolation**:
   - Holds full Node.js privileges but MUST NOT import renderer code or Vite client assets.
   - All responses returned through IPC and HTTP must be serializable.

---

## 4. Naming Conventions

- **Files & Folders**: `kebab-case` (e.g., `file-manager.ts`, `file-change.schema.ts`, `local-server.ts`).
- **React Components**: `PascalCase.tsx` (e.g., `DiffViewer.tsx`, `WorkspaceSelector.tsx`).
- **Hooks**: `camelCase.ts` prefixed with `use` (e.g., `useBridgeIpc.ts`).
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `BRIDGE_PROTOCOL_VERSION`, `ALLOWED_COMMANDS`).
- **Types / Interfaces / Classes**: `PascalCase` (e.g., `FileChange`, `SecurityService`, `ApplyBatchResult`).
