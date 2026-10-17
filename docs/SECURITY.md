# Bridge Security Architecture & Threat Model

Because Bridge performs local file modifications and controlled command execution on the developer's computer, security is a core architectural requirement.

This document details implemented security controls, trust boundaries, the threat model, and planned future enhancements.

---

## 1. Threat Model

| Threat | Description | Implemented Countermeasure | Status |
| :--- | :--- | :--- | :--- |
| **Rogue Website Impersonation** | A malicious website in another browser tab attempts to trigger file writes via `http://localhost:<port>`. | 1. Local server binds strictly to `127.0.0.1`.<br>2. CORS strictly restricts allowed origins to `chrome-extension://*` and loopback.<br>3. Timing-safe cryptographic bearer token required on all non-preflight requests.<br>4. Secrets never exposed in logs or responses. | **Implemented** |
| **Path Traversal Attacks** | Malicious AI responses output paths like `../../../../.ssh/authorized_keys` to overwrite system files. | 1. `SafeRelativePathSchema` prohibits absolute paths, null bytes, and `..` segments.<br>2. `SecurityService.assertPathWithinWorkspace()` resolves canonical real paths via `realpathSync` to detect symlink escapes.<br>3. File writes are rejected if they resolve outside the designated workspace. | **Implemented** |
| **Malicious Shell Injections** | Injection of commands like `rm -rf /` or shell chaining `git status; evil_script`. | 1. Direct shell invocation (`/bin/sh`, `cmd.exe`) is completely disallowed.<br>2. Execution strictly uses `execFile` with explicit argument arrays.<br>3. Strict command allowlist enforces permitted executables and subcommands.<br>4. Rejection of shell metacharacters (`;&|$\` etc.). | **Implemented** |
| **Malicious Renderer Code (XSS to RCE)** | Compromised renderer code or XSS in preview tries to invoke Node.js system APIs. | 1. `contextIsolation: true`.<br>2. `nodeIntegration: false`.<br>3. Sandbox enabled.<br>4. Strict Content Security Policy (CSP) in `index.html`.<br>5. Preload script exposes only a minimal, typed interface via `contextBridge`. | **Implemented** |
| **Overprivileged Browser Extension** | Chrome extension requests broad permissions that could expose user browsing data. | 1. Minimum permissions requested: `storage` only.<br>2. `host_permissions` strictly bounded to `http://127.0.0.1/*` and `ws://127.0.0.1/*`.<br>3. Extension never has direct access to local filesystem. | **Implemented** |

---

## 2. Implemented Protections

### 2.1 Authentication & Pairing
- **Cryptographic Token**: Upon startup, the Desktop main process generates a 256-bit cryptographic pairing token using `node:crypto.randomBytes(32).toString('hex')`.
- **Timing-Safe Verification**: Incoming tokens are verified using `crypto.timingSafeEqual` to eliminate timing side-channel attacks.
- **Header & Log Redaction**: Fastify request logging is configured to prevent pairing secrets and authorization headers from leaking to standard output or log files.
- **Regeneration**: Users can regenerate the pairing token anytime from the Desktop settings modal, immediately invalidating any active sessions.

### 2.2 Local Server Exposure
- **Strict Loopback Binding**: The Fastify server binds explicitly to `127.0.0.1`, never `0.0.0.0`. This prevents external machines on the same local network (LAN) from reaching the port.
- **CORS Validation**: Cross-Origin Resource Sharing is enforced. Only origins starting with `chrome-extension://` or loopback origins are accepted.

### 2.3 Filesystem Confinement
- **Explicit Workspace Selection**: File operations are blocked entirely until the developer selects an active workspace folder using the native OS dialog.
- **Path Sanitization**: All file paths undergo Zod schema validation (`SafeRelativePathSchema`):
  - Must not start with `/` or Windows drive letter (e.g., `C:`).
  - Must not contain `\0` null bytes.
  - Must not contain `..` directory traversal segments.
- **Symlink Escape Defense**: `SecurityService.assertPathWithinWorkspace()` resolves the canonical real path via `fs.realpathSync` to guarantee that symlinks inside the workspace do not point outside the designated workspace.

### 2.4 Command Execution Safeguards
- **Binary & Subcommand Allowlist**: Commands are limited to specific development tools (`git`, `pnpm`, `npm`) with defined read-only or verification subcommands (`status`, `diff`, `test`, `typecheck`).
- **No Raw Shell Interpretation**: Execution is carried out via `child_process.execFile` with an array of arguments, avoiding shell string parsing (`/bin/sh -c`).
- **Argument Sanitization**: Arguments containing dangerous shell characters (`;`, `&`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`) are rejected.

### 2.5 Electron Hardening
- **Context Isolation**: Enabled (`contextIsolation: true`).
- **Node Integration**: Disabled (`nodeIntegration: false`).
- **Process Sandboxing**: Enabled (`sandbox: true`).
- **Navigation Lock**: External links clicked inside the Electron window are denied from loading in the webview and instead dispatched safely to the user's default browser via `shell.openExternal`.
- **Content Security Policy**: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';`.

---

## 3. Planned Protections (Future Enhancements)

The following protections represent future roadmap items and are **not yet implemented**:

1. **Mutual TLS (mTLS) / Self-Signed HTTPS**: Currently, traffic over `127.0.0.1` is plaintext HTTP. While loopback traffic never crosses the physical network wire, adding local TLS certificates will provide defense-in-depth against malicious processes running under the same local user account.
2. **Interactive Destructive Operation Prompts**: A prompt modal asking the user to confirm destructive operations (such as `delete` actions or large batch rewrites) before writing to disk.
3. **OS-level Keychain Storage**: Storing the pairing token in the macOS Keychain / Windows Credential Vault instead of memory/settings.
4. **Per-Domain Chat Origin Allowlist**: Allowing the extension to activate only on specific verified AI domains (e.g., `chatgpt.com`, `claude.ai`, `gemini.google.com`) rather than `<all_urls>`.
