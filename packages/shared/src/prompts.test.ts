import { describe, expect, it } from 'vitest';
import type { TreeEntry } from './files';
import { parseChat } from './parser';
import {
  buildContextMessage,
  buildSessionPrompt,
  formatContextBlock,
  pickFence,
  summarizeTree
} from './prompts';

const file = (path: string): TreeEntry => ({ path, type: 'file', size: 10 });
const dir = (path: string): TreeEntry => ({ path, type: 'dir', size: 0 });

describe('pickFence', () => {
  it('uses three backticks for plain content', () => {
    expect(pickFence('const a = 1;\n')).toBe('```');
  });

  it('goes one longer than any backtick run', () => {
    expect(pickFence('```js\nx\n```')).toBe('````');
    expect(pickFence('````md\n```\n````')).toBe('`````');
    expect(pickFence('inline `code` and ``double``')).toBe('```');
  });

  it('keeps content with ``` and ```` intact through the parser', () => {
    const content = '# Doc\n````md\n```js\nx\n```\n````\n';
    const text = formatContextBlock('doc.md', content).replace('@@CONTEXT', '@@FILE');
    expect(parseChat(text).edits[0]?.content).toBe(content);
  });
});

describe('formatContextBlock', () => {
  it('writes the marker in inline code and a fence with the extension', () => {
    expect(formatContextBlock('src/a.ts', 'x\n')).toBe('`@@CONTEXT src/a.ts@@`\n```ts\nx\n```');
  });

  it('adds a final newline when the file has none', () => {
    expect(formatContextBlock('Makefile', 'all:')).toBe('`@@CONTEXT Makefile@@`\n```\nall:\n```');
  });
});

describe('buildContextMessage', () => {
  it('lists refused files with a reason', () => {
    const text = buildContextMessage(
      [{ path: 'a.ts', content: 'a\n' }],
      [{ path: '.env', reason: 'protected file' }]
    );
    expect(text).toContain('`@@CONTEXT a.ts@@`');
    expect(text).toContain('Bridge could not send: .env (protected file).');
  });
});

describe('summarizeTree', () => {
  const tree = [
    dir('src'),
    dir('src/lib'),
    file('src/lib/a.ts'),
    file('src/lib/b.ts'),
    file('src/main.ts'),
    { ...dir('node_modules'), collapsed: true as const },
    file('package.json')
  ];

  it('lists everything as an outline when it fits', () => {
    expect(summarizeTree(tree).lines).toEqual([
      'src/',
      '  lib/',
      '    a.ts',
      '    b.ts',
      '  main.ts',
      'node_modules/ (not listed)',
      'package.json'
    ]);
  });

  it('summarises the deepest folders first when over the limit', () => {
    const summary = summarizeTree(tree, 5);
    expect(summary).toEqual({
      lines: [
        'src/',
        '  lib/ (2 more entries)',
        '  main.ts',
        'node_modules/ (not listed)',
        'package.json'
      ],
      total: 7,
      shown: 5
    });
  });

  it('cuts the top level when even that is too big', () => {
    const flat = Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`));
    const summary = summarizeTree(flat, 3);
    expect(summary.lines).toEqual(['f0.txt', 'f1.txt', 'f2.txt', '(7 more entries not listed)']);
  });

  it('stays near 1,500 entries by default', () => {
    const big: TreeEntry[] = [];
    for (let d = 0; d < 40; d += 1) {
      big.push(dir(`d${d}`));
      for (let f = 0; f < 60; f += 1) big.push(file(`d${d}/f${f}.ts`));
    }
    const summary = summarizeTree(big);
    expect(summary.total).toBe(2440);
    expect(summary.shown).toBe(40);
    expect(summary.lines[0]).toBe('d0/ (60 more entries)');
  });
});

describe('buildSessionPrompt', () => {
  const prompt = buildSessionPrompt({ projectName: 'demo', tree: [file('a.ts')] });

  it('teaches the FILE, READ and CONTEXT markers', () => {
    expect(prompt).toContain('`@@FILE src/app.ts@@`');
    expect(prompt).toContain('`@@READ src/app.ts@@`');
    expect(prompt).toContain('@@CONTEXT path@@');
    expect(prompt).toContain('Never send partial files');
  });

  it('includes the project name and tree', () => {
    expect(prompt).toContain('"demo"');
    expect(prompt).toContain('Project files (1 entry).');
    expect(prompt).toContain('```\na.ts\n```');
  });

  it('never names a vendor', () => {
    expect(prompt).not.toMatch(/openai|chatgpt|codex|gpt/i);
  });

  it('is not itself parsed as an edit if echoed back', () => {
    // The example sits in a fence after the marker, so it would parse as one example edit.
    // That is fine for a user message (never parsed); this pins the example's path.
    expect(parseChat(prompt).edits.map((e) => e.path)).toEqual(['src/app.ts']);
  });
});
