import { describe, expect, it } from 'vitest';
import { parseFileBlocks } from './parser';

const block = (path: string, body: string, fence = '```ts') =>
  `@@FILE ${path}@@\n${fence}\n${body}\n${fence.replace(/[^`~]/g, '')}`;

describe('parseFileBlocks', () => {
  it('parses a single block', () => {
    const text = `Here you go:\n\n${block('src/a.ts', 'export const a = 1;')}\n\nDone.`;
    expect(parseFileBlocks(text)).toEqual([{ path: 'src/a.ts', content: 'export const a = 1;\n' }]);
  });

  it('parses multiple blocks in order', () => {
    const text = [block('a.ts', 'a'), 'some prose', block('b/c.css', 'b {}', '```css')].join('\n');
    expect(parseFileBlocks(text)).toEqual([
      { path: 'a.ts', content: 'a\n' },
      { path: 'b/c.css', content: 'b {}\n' }
    ]);
  });

  it('returns nothing when there are no blocks', () => {
    expect(parseFileBlocks('')).toEqual([]);
    expect(parseFileBlocks('just text\n```ts\nconst x = 1;\n```')).toEqual([]);
  });

  it('ignores a block whose fence never closes', () => {
    const text = `${block('ok.ts', 'ok')}\n@@FILE broken.ts@@\n\`\`\`ts\nconst x = 1;\n`;
    expect(parseFileBlocks(text)).toEqual([{ path: 'ok.ts', content: 'ok\n' }]);
  });

  it('keeps spaces inside paths', () => {
    expect(parseFileBlocks(block('docs/my notes/read me.md', '# Hi'))).toEqual([
      { path: 'docs/my notes/read me.md', content: '# Hi\n' }
    ]);
  });

  it('allows a longer fence to wrap content that contains ```', () => {
    const body = '# Readme\n```sh\nnpm i\n```';
    expect(parseFileBlocks(block('README.md', body, '````md'))).toEqual([
      { path: 'README.md', content: `${body}\n` }
    ]);
  });

  it('normalises CRLF line endings', () => {
    const text = '@@FILE a.ts@@\r\n```ts\r\nconst a = 1;\r\n```\r\n';
    expect(parseFileBlocks(text)).toEqual([{ path: 'a.ts', content: 'const a = 1;\n' }]);
  });

  it('ignores a header that is not followed by a fence', () => {
    expect(parseFileBlocks('@@FILE a.ts@@\nnot a fence\n```ts\nx\n```')).toEqual([]);
  });
});
