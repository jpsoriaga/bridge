import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SecurityService {
  private pairingToken: string;

  constructor() {
    this.pairingToken = crypto.randomBytes(32).toString('hex');
  }

  getPairingToken(): string {
    return this.pairingToken;
  }

  regeneratePairingToken(): string {
    this.pairingToken = crypto.randomBytes(32).toString('hex');
    return this.pairingToken;
  }

  /**
   * Constant-time token verification to mitigate timing attacks.
   */
  verifyToken(providedToken: string | undefined): boolean {
    if (!providedToken) return false;
    const expected = Buffer.from(this.pairingToken, 'utf8');
    const actual = Buffer.from(providedToken, 'utf8');
    if (expected.length !== actual.length) {
      return false;
    }
    return crypto.timingSafeEqual(expected, actual);
  }

  /**
   * Asserts that a resolved file path is strictly within the allowed workspace root.
   * Resolves symlinks to ensure no symlink escape.
   */
  assertPathWithinWorkspace(workspaceRoot: string, relativePath: string): string {
    if (!workspaceRoot) {
      throw new Error('No workspace directory is selected.');
    }

    const resolvedRoot = path.resolve(workspaceRoot);
    const targetPath = path.resolve(resolvedRoot, relativePath);

    // Initial check: target path must start with workspace path + separator
    if (!targetPath.startsWith(resolvedRoot + path.sep) && targetPath !== resolvedRoot) {
      throw new Error(`Path traversal violation: target path "${relativePath}" escapes workspace.`);
    }

    // Symlink resolution check for existing paths or parent paths
    let current = targetPath;
    while (current !== resolvedRoot && !fs.existsSync(current)) {
      current = path.dirname(current);
    }

    if (fs.existsSync(current)) {
      const realExisting = fs.realpathSync(current);
      const realRoot = fs.realpathSync(resolvedRoot);
      if (!realExisting.startsWith(realRoot + path.sep) && realExisting !== realRoot) {
        throw new Error(`Symlink escape violation: real path "${realExisting}" is outside workspace.`);
      }
    }

    return targetPath;
  }
}

export const securityService = new SecurityService();
