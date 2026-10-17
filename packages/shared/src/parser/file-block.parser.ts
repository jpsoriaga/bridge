import { SafeRelativePathSchema } from '../schemas/file-change.schema';
import type { FileAction, ParsedFileChange } from '../types/diff';

export interface ParseResult {
  changes: ParsedFileChange[];
  errors: Array<{
    line?: number;
    message: string;
    raw?: string;
  }>;
}

/**
 * Parser for @@FILE blocks commonly emitted by AI chat assistants.
 *
 * Supported formats:
 *
 * Format A: Tag block
 * @@FILE path/to/file.ts
 * content...
 * @@END_FILE
 *
 * Format B: With action attribute
 * @@FILE [create|modify|delete] path/to/file.ts
 * content...
 * @@END_FILE
 *
 * Format C: Markdown fence block with @@FILE marker
 * ```ts @@FILE path/to/file.ts
 * content...
 * ```
 */
export function parseFileBlocks(rawText: string): ParseResult {
  const result: ParseResult = {
    changes: [],
    errors: []
  };

  if (!rawText || typeof rawText !== 'string') {
    return result;
  }

  // Regex for tag-style blocks: @@FILE [action]? <path> ... @@END_FILE
  const tagBlockRegex = /@@FILE:?\s*(?:\[(create|modify|delete)\]\s*)?([^\r\n]+)\r?\n([\s\S]*?)(?:@@END_FILE|(?=@@FILE)|$)/gi;

  // Regex for fenced code blocks with @@FILE
  const fencedRegex = /```[a-zA-Z0-9_-]*\s*@@FILE:?\s*(?:\[(create|modify|delete)\]\s*)?([^\r\n]+)\r?\n([\s\S]*?)```/gi;

  const matches: Array<{
    actionRaw?: string;
    pathRaw: string;
    content: string;
    rawBlock: string;
    index: number;
  }> = [];

  // Match fenced blocks first
  let match: RegExpExecArray | null;
  while ((match = fencedRegex.exec(rawText)) !== null) {
    const [rawBlock, actionRaw, pathRaw, content] = match;
    matches.push({
      actionRaw,
      pathRaw: (pathRaw || '').trim(),
      content: content || '',
      rawBlock,
      index: match.index
    });
  }

  // If no fenced blocks found, match tag blocks
  if (matches.length === 0) {
    while ((match = tagBlockRegex.exec(rawText)) !== null) {
      const [rawBlock, actionRaw, pathRaw, content] = match;
      const trimmedPath = (pathRaw || '').trim();
      // Ignore trailing @@END_FILE if present in rawBlock
      matches.push({
        actionRaw,
        pathRaw: trimmedPath,
        content: (content || '').trimEnd(),
        rawBlock,
        index: match.index
      });
    }
  }

  for (const item of matches) {
    // Determine action
    let action: FileAction = 'modify';
    if (item.actionRaw) {
      const normalizedAction = item.actionRaw.toLowerCase();
      if (normalizedAction === 'create' || normalizedAction === 'modify' || normalizedAction === 'delete') {
        action = normalizedAction;
      }
    }

    // Clean up quotes around path if user/model wrapped it
    const cleanPath = item.pathRaw.replace(/^["'`]|["'`]$/g, '').trim();

    // Validate path safety
    const pathValidation = SafeRelativePathSchema.safeParse(cleanPath);
    if (!pathValidation.success) {
      result.errors.push({
        message: `Invalid or unsafe file path "${cleanPath}": ${pathValidation.error.errors.map((e) => e.message).join(', ')}`,
        raw: item.rawBlock
      });
      continue;
    }

    // Compute approximate line number in original text
    const lineNumber = rawText.slice(0, item.index).split('\n').length;

    result.changes.push({
      path: pathValidation.data,
      action,
      content: item.content,
      rawBlock: item.rawBlock,
      lineNumber
    });
  }

  return result;
}
