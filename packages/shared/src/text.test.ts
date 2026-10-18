import { describe, expect, it } from 'vitest';
import { looksBinary, matchTrailingNewline } from './text';

describe('matchTrailingNewline', () => {
  it('keeps a file without a trailing newline without one', () => {
    expect(matchTrailingNewline('a\nb\n', 'a\nold')).toBe('a\nb');
    expect(matchTrailingNewline('a\r\nb\r\n', 'old')).toBe('a\r\nb');
  });

  it('keeps a trailing newline where there was one', () => {
    expect(matchTrailingNewline('a\nb\n', 'old\n')).toBe('a\nb\n');
    expect(matchTrailingNewline('a\nb', 'old\n')).toBe('a\nb\n');
  });

  it('leaves new and empty files, and empty content, alone', () => {
    expect(matchTrailingNewline('a\n', null)).toBe('a\n');
    expect(matchTrailingNewline('a\n', '')).toBe('a\n');
    expect(matchTrailingNewline('', 'old')).toBe('');
  });
});

describe('looksBinary', () => {
  it('spots a NUL character', () => {
    expect(looksBinary('a\u0000b')).toBe(true);
    expect(looksBinary('plain text')).toBe(false);
  });
});
