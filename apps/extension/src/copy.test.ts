import { describe, expect, it } from 'vitest';
import {
  FILE_ERROR_CODES,
  FILE_ERROR_LABELS,
  FILE_ERROR_MESSAGES,
  PAUSE_REASON_TEXT,
  PAUSE_REASONS
} from '@bridge/shared';
import { failureText } from './content/chat/cards/diff-card';
import { sessionErrorText } from './sidepanel/request';
import type { SessionError } from './messages';

// Every status, error and pause reason the extension can show has words for it.

describe('copy', () => {
  it('has a message and a label for every error code', () => {
    for (const code of FILE_ERROR_CODES) {
      expect(FILE_ERROR_MESSAGES[code], code).toMatch(/\.$/);
      expect(FILE_ERROR_LABELS[code], code).toBeTruthy();
      expect(failureText({ code, message: 'x' })).toBe(FILE_ERROR_MESSAGES[code]);
    }
    for (const code of ['not-connected', 'timeout', 'bad-response', 'no-session'] as const) {
      expect(failureText({ code, message: 'x' })).toMatch(/\.$/);
    }
    expect(failureText(undefined)).toMatch(/Reload/);
  });

  it('explains every pause reason', () => {
    for (const reason of PAUSE_REASONS) expect(PAUSE_REASON_TEXT[reason], reason).toMatch(/\.$/);
  });

  it('explains every session error', () => {
    const errors: SessionError[] = [
      'not-connected',
      'no-project',
      'no-chat-tab',
      'layout-unknown',
      'no-composer',
      'not-inserted',
      'no-session',
      'failed'
    ];
    for (const error of errors) expect(sessionErrorText(error), error).toMatch(/\.$/);
  });
});
