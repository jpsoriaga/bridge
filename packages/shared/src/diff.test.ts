import { describe, expect, it } from 'vitest';
import { diffFile } from './diff';

describe('diffFile', () => {
  it('shows a create as all added lines', () => {
    expect(diffFile(null, 'a\nb\n')).toEqual({
      status: 'new',
      added: 2,
      removed: 0,
      lines: [
        { kind: 'add', text: 'a' },
        { kind: 'add', text: 'b' }
      ]
    });
  });

  it('counts an empty new file as zero lines', () => {
    expect(diffFile(null, '')).toEqual({ status: 'new', added: 0, removed: 0, lines: [] });
  });

  it('diffs a modify with hunk headers and context', () => {
    const before = 'one\ntwo\nthree\n';
    const after = 'one\n2\nthree\nfour\n';
    const diff = diffFile(before, after);
    expect(diff.status).toBe('modified');
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.lines).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,4 @@' },
      { kind: 'ctx', text: 'one' },
      { kind: 'del', text: 'two' },
      { kind: 'add', text: '2' },
      { kind: 'ctx', text: 'three' },
      { kind: 'add', text: 'four' }
    ]);
  });

  it('reports unchanged content', () => {
    expect(diffFile('same\n', 'same\n')).toEqual({
      status: 'unchanged',
      added: 0,
      removed: 0,
      lines: []
    });
  });

  it('treats a CRLF file with the same text as unchanged', () => {
    expect(diffFile('a\r\nb\r\n', 'a\nb\n').status).toBe('unchanged');
  });

  it('diffs a CRLF file by line, without stray carriage returns', () => {
    const diff = diffFile('a\r\nb\r\nc\r\n', 'a\nB\nc\n');
    expect(diff).toMatchObject({ status: 'modified', added: 1, removed: 1 });
    expect(diff.lines.some((line) => line.text.includes('\r'))).toBe(false);
  });

  it('notices a missing final newline', () => {
    expect(diffFile('a', 'a\n')).toMatchObject({ status: 'modified', added: 1, removed: 1 });
  });

  it('keeps far-apart changes in separate hunks', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after = before.replace('line 1\n', 'LINE 1\n').replace('line 28', 'LINE 28');
    expect(diffFile(before, after).lines.filter((l) => l.kind === 'hunk')).toHaveLength(2);
  });
});
