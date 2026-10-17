import type { UndoEntry } from '@bridge/shared';
import { fileManager } from '../filesystem/file-manager';

export class HistoryManager {
  private historyStack: UndoEntry[] = [];
  private maxHistorySize = 50;

  recordBatch(entry: UndoEntry): void {
    this.historyStack.push(entry);
    if (this.historyStack.length > this.maxHistorySize) {
      this.historyStack.shift();
    }
  }

  canUndo(): boolean {
    return this.historyStack.length > 0;
  }

  getHistory(): UndoEntry[] {
    return [...this.historyStack];
  }

  async undoLast(): Promise<{ success: boolean; batchId?: string; revertedFiles: string[] }> {
    const lastEntry = this.historyStack.pop();
    if (!lastEntry) {
      return { success: false, revertedFiles: [] };
    }

    const revertedFiles: string[] = [];

    // Revert files in reverse order
    for (let i = lastEntry.changes.length - 1; i >= 0; i--) {
      const item = lastEntry.changes[i]!;
      const reverted = await fileManager.revertFile(item.path, item.action, item.originalContent);
      if (reverted) {
        revertedFiles.push(item.path);
      }
    }

    return {
      success: true,
      batchId: lastEntry.batchId,
      revertedFiles
    };
  }

  clear(): void {
    this.historyStack = [];
  }
}

export const historyManager = new HistoryManager();
