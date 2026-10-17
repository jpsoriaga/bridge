import { z } from 'zod';

/**
 * Validates that a file path is relative, normalized, and safe from path traversal.
 */
export const SafeRelativePathSchema = z
  .string()
  .min(1, 'Path cannot be empty')
  .max(1024, 'Path is too long')
  .refine((path) => !path.includes('\0'), {
    message: 'Path cannot contain null bytes'
  })
  .refine((path) => !path.startsWith('/') && !path.startsWith('\\'), {
    message: 'Path must be relative, not absolute'
  })
  .refine((path) => !/^[a-zA-Z]:/.test(path), {
    message: 'Windows drive letters are not allowed in relative paths'
  })
  .refine(
    (path) => {
      const segments = path.replace(/\\/g, '/').split('/');
      return !segments.includes('..');
    },
    {
      message: 'Path cannot contain directory traversal (..) segments'
    }
  );

export const FileActionSchema = z.enum(['create', 'modify', 'delete']);

export const FileChangeSchema = z.object({
  path: SafeRelativePathSchema,
  action: FileActionSchema,
  content: z.string(),
  previousContent: z.string().optional()
});

export const ApplyChangesRequestSchema = z.object({
  batchId: z.string().uuid(),
  changes: z.array(FileChangeSchema).min(1, 'At least one file change must be provided')
});

export type SafeRelativePath = z.infer<typeof SafeRelativePathSchema>;
export type FileChangePayload = z.infer<typeof FileChangeSchema>;
export type ApplyChangesRequestPayload = z.infer<typeof ApplyChangesRequestSchema>;
