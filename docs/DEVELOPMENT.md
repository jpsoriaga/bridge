# Bridge Development Guide

This guide covers setup instructions, development workflows, dependency management, and troubleshooting for the Bridge monorepo.

---

## 1. Prerequisites & Tooling

Before working on the Bridge codebase, ensure your environment meets these version requirements:

- **Node.js**: `v20.0.0` or higher (`v24.x` recommended and tested)
- **pnpm**: `v9.0.0` or higher (installed via Corepack)
- **Operating System**: macOS (tested), Windows 10/11, or modern Linux
- **Browser**: Google Chrome or any Chromium-based browser (Brave, Edge, Arc)

### Activating pnpm via Corepack
If pnpm is not yet enabled on your machine:
```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

Verify your installed versions:
```bash
node -v   # e.g., v24.13.1
pnpm -v   # e.g., 9.15.4
```

---

## 2. Initial Setup & Workspace Installation

Clone the repository and install all workspace dependencies from the root directory:

```bash
git clone <repository-url> bridge
cd bridge

# Install dependencies across all packages using pnpm workspaces
pnpm install
```

---

## 3. Development Commands

The root `package.json` provides scripts to manage development workflows across all apps:

### 3.1 Running Desktop in Development
Launches the Electron main process, preload watcher, and Vite React hot-reload server:
```bash
pnpm run dev:desktop
# or simply:
pnpm run dev
```

### 3.2 Running Extension in Development
Launches Vite with CRXJS hot-module-replacement for the Chrome extension:
```bash
pnpm run dev:extension
```
Then load the extension into Chrome:
1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the `apps/extension/dist/` directory.

### 3.3 Running Full Verification
Runs TypeScript typechecking and builds every package in sequence:
```bash
# Typecheck everything
pnpm run typecheck

# Build everything
pnpm run build

# Or run the automated verification script:
./scripts/verify.sh
```

---

## 4. How to Add Dependencies

Bridge uses `pnpm` workspace filters to manage dependencies cleanly and avoid duplicate packages:

### 4.1 Adding a dependency to an individual app or package
- To add a dependency to the **Desktop** app:
  ```bash
  pnpm --filter @bridge/desktop add <package-name>
  ```
- To add a dev dependency to the **Desktop** app:
  ```bash
  pnpm --filter @bridge/desktop add -D <package-name>
  ```
- To add a dependency to the **Extension**:
  ```bash
  pnpm --filter @bridge/extension add <package-name>
  ```
- To add a dependency to the **Shared** package:
  ```bash
  pnpm --filter @bridge/shared add <package-name>
  ```

### 4.2 Adding a root-level dev dependency
Use `-w` (workspace root):
```bash
pnpm add -w -D <tool-name>
```

---

## 5. Adding New Shared Types, Schemas, or Parser Features

1. **New Schema or Type**:
   - Add the interface to `packages/shared/src/types/`.
   - Add the corresponding Zod schema to `packages/shared/src/schemas/`.
   - Re-export from `packages/shared/src/index.ts`.
2. **Build Shared Package**:
   ```bash
   pnpm run build:shared
   ```
3. **Use in Apps**:
   - Import directly in `@bridge/desktop` or `@bridge/extension`:
     ```ts
     import { MyNewSchema, type MyNewType } from '@bridge/shared';
     ```

---

## 6. Troubleshooting Common Issues

### Issue 1: "Cannot reach Bridge Desktop at 127.0.0.1" in Extension
- **Cause**: Bridge Desktop application is either not running or listening on a different port.
- **Solution**:
  1. Open Bridge Desktop.
  2. Click **Pairing Settings ⚙** in the top header.
  3. Note the port number (default `49152`) and token.
  4. Open the Extension Options and ensure the port and token match.

### Issue 2: "Path traversal violation: target path escapes workspace"
- **Cause**: The AI code block contains an absolute path (e.g. `/etc/passwd`) or relative traversal (`../../secret`).
- **Solution**: Bridge strictly prohibits paths escaping the workspace root. Ensure paths in `@@FILE` blocks are relative to the project root (e.g. `src/index.ts`).

### Issue 3: Extension changes do not reload in Chrome
- **Cause**: Chrome Manifest V3 service workers can enter idle/suspended states.
- **Solution**: Go to `chrome://extensions/` and click the reload icon on the Bridge extension card.
