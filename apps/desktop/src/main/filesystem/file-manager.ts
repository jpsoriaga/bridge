import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApplyFileResult, FileAction, FileChange } from '@bridge/shared';
import { configService } from '../services/config.service';
import { PathValidator } from './path-validator';

export class FileManager {
  /**
   * Reads original content of a file before modifying or deleting it.
   */
  async readOriginal(relativePath: string): Promise<string | undefined> {
    const workspace = configService.getSelectedWorkspace();
    if (!workspace) return undefined;

    try {
      const fullPath = PathValidator.validateAndResolve(workspace, relativePath);
      const content = await fs.readFile(fullPath, 'utf8');
      return content;
    } catch {
      return undefined;
    }
  }

  /**
   * Applies a single file change to disk.
   */
  async applyFile(change: FileChange): Promise<ApplyFileResult> {
    const workspace = configService.getSelectedWorkspace();
    if (!workspace) {
      return {
        path: change.path,
        action: change.action,
        success: false,
        error: 'No active workspace selected in Bridge Desktop.'
      };
    }

    try {
      const fullPath = PathValidator.validateAndResolve(workspace, change.path);

      if (change.action === 'delete') {
        try {
          await fs.unlink(fullPath);
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (code !== 'ENOENT') {
            throw err;
          }
        }
      } else {
        // create or modify
        const parentDir = path.dirname(fullPath);
        await fs.mkdir(parentDir, { recursive: true });
        await fs.writeFile(fullPath, change.content, 'utf8');
      }

      return {
        path: change.path,
        action: change.action,
        success: true
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        path: change.path,
        action: change.action,
        success: false,
        error: msg
      };
    }
  }

  /**
   * Reverts a file change using historical state.
   */
  async revertFile(
    relativePath: string,
    action: FileAction,
    originalContent?: string
  ): Promise<boolean> {
    const workspace = configService.getSelectedWorkspace();
    if (!workspace) return false;

    try {
      const fullPath = PathValidator.validateAndResolve(workspace, relativePath);

      if (action === 'create') {
        // Was created, so undo deletes it
        await fs.unlink(fullPath).catch(() => {});
        return true;
      }

      if (action === 'modify' || action === 'delete') {
        // Was modified or deleted, so undo restores originalContent
        if (typeof originalContent === 'string') {
          const parentDir = path.dirname(fullPath);
          await fs.mkdir(parentDir, { recursive: true });
          await fs.writeFile(fullPath, originalContent, 'utf8');
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }
}

export const fileManager = new FileManager();
