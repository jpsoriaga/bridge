export type FileAction = 'create' | 'modify' | 'delete';

export interface FileChange {
  path: string;
  action: FileAction;
  content: string;
  previousContent?: string;
}

export interface ParsedFileChange {
  path: string;
  action: FileAction;
  content: string;
  rawBlock: string;
  lineNumber?: number;
}

export interface ApplyFileResult {
  path: string;
  success: boolean;
  action: FileAction;
  error?: string;
}

export interface ApplyBatchResult {
  batchId: string;
  appliedAt: string;
  results: ApplyFileResult[];
  canUndo: boolean;
}

export interface UndoEntry {
  batchId: string;
  timestamp: string;
  changes: Array<{
    path: string;
    action: FileAction;
    originalContent?: string;
  }>;
}
