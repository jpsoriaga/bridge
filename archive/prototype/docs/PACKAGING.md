# Bridge Packaging & Distribution Guide

This document describes how to package Bridge Desktop for production distribution across macOS and Windows, including build configurations, prerequisites, code signing, and notarization.

---

## 1. Overview of Packaging Architecture

Bridge uses `electron-builder` coupled with `electron-vite`:

1. `electron-vite build`: Compiles the TypeScript main process, preload script, and React renderer application into optimized output chunks in `apps/desktop/out/`.
2. `electron-builder`: Reads `apps/desktop/electron-builder.yml`, bundles the Node.js runtime, native dependencies, and creates platform-specific installers (`.dmg` for macOS and `.exe` NSIS installer for Windows).

---

## 2. Packaging Commands

From the monorepo root:

### 2.1 macOS DMG Packaging
```bash
# Builds the desktop app and generates a DMG installer for macOS
pnpm run package:mac
```
Output artifacts are saved to: `apps/desktop/dist/`
- `Bridge-<version>-mac-arm64.dmg` (Apple Silicon)
- `Bridge-<version>-mac-x64.dmg` (Intel)
- `Bridge-<version>-mac-arm64.zip`
- `Bridge-<version>-mac-x64.zip`

### 2.2 Windows EXE/NSIS Packaging
```bash
# Builds the desktop app and generates an NSIS installer for Windows
pnpm run package:win
```
Output artifacts are saved to: `apps/desktop/dist/`
- `Bridge-<version>-Setup-x64.exe`

---

## 3. Configuration Reference (`electron-builder.yml`)

The desktop packaging settings are configured in `apps/desktop/electron-builder.yml`:

```yaml
appId: com.bridge.app
productName: Bridge
directories:
  output: dist
  buildResources: resources
files:
  - out/**/*
  - package.json
mac:
  target:
    - target: dmg
      arch:
        - arm64
        - x64
    - target: zip
      arch:
        - arm64
        - x64
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.plist
dmg:
  artifactName: ${productName}-${version}-${os}-${arch}.${ext}
win:
  target:
    - target: nsis
      arch:
        - x64
  artifactName: ${productName}-${version}-Setup-${arch}.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  deleteAppDataOnUninstall: true
```

---

## 4. Code Signing & Notarization Requirements

### 4.1 macOS Notarization & Gatekeeper
macOS requires code signing with an Apple Developer certificate and Apple Notarization to avoid Gatekeeper warnings ("Bridge is damaged and cannot be opened"):

1. **Environment Variables**:
   ```bash
   export CSC_LINK="/path/to/developer_certificate.p12"
   export CSC_KEY_PASSWORD="certificate_password"
   export APPLE_ID="developer@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="YOUR_TEAM_ID"
   ```
2. **Entitlements**:
   Configured in `apps/desktop/resources/entitlements.mac.plist` with `hardenedRuntime: true`.

### 4.2 Windows Code Signing
Unsigned executables will trigger Microsoft Defender SmartScreen warnings:

1. **Environment Variables**:
   ```bash
   export WIN_CSC_LINK="/path/to/windows_cert.pfx"
   export WIN_CSC_KEY_PASSWORD="cert_password"
   ```

---

## 5. Chrome Extension Packaging

To produce a production distribution of the Chrome extension:

```bash
# Build the extension bundle
pnpm run build:extension
```

Output directory: `apps/extension/dist/`

### Distributing to the Chrome Web Store:
1. Compress the contents of `apps/extension/dist/` into a `.zip` archive:
   ```bash
   cd apps/extension/dist && zip -r ../../bridge-extension.zip . && cd ../../
   ```
2. Upload `bridge-extension.zip` to the Chrome Web Store Developer Dashboard.

---

## 6. Platform-Specific Considerations

| Platform | Considerations |
| :--- | :--- |
| **macOS** | Cross-compiling for macOS from Linux/Windows is not supported by Apple's notarization tools. macOS builds should run on a macOS host or GitHub Actions `macos-latest` runner. |
| **Windows** | Windows builds can be compiled on macOS or Linux if `wine` and `mono` are installed, but native compilation on `windows-latest` is recommended for clean NSIS installer generation. |
