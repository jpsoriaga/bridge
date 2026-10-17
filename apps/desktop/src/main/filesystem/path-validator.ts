import { SafeRelativePathSchema } from '@bridge/shared';
import { securityService } from '../services/security.service';

export class PathValidator {
  /**
   * Validates relative path format and ensures it remains confined to the active workspace.
   */
  static validateAndResolve(workspaceRoot: string, relativePath: string): string {
    const parseResult = SafeRelativePathSchema.safeParse(relativePath);
    if (!parseResult.success) {
      throw new Error(`Invalid relative path: ${parseResult.error.errors.map((e) => e.message).join(', ')}`);
    }

    return securityService.assertPathWithinWorkspace(workspaceRoot, parseResult.data);
  }
}
