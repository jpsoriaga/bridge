import { describe, expect, it } from 'vitest';
import type { TreeEntry } from './files';
import { parseChat } from './parser';
import {
  buildContextMessage,
  buildFollowUp,
  buildRunMessage,
  buildSessionPrompt,
  FORMAT_FOOTER,
  FORMAT_REMINDER,
  formatContextBlock,
  formatRunResult,
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
    ).text;
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

const result = {
  argv: ['pnpm', 'test'],
  status: 'exited' as const,
  exitCode: 1,
  signal: null,
  durationMs: 3210,
  output: 'FAIL src/a.test.ts\n  expected 1 to be 2\n'
};

describe('buildSessionPrompt', () => {
  const allowlist = ['pnpm test', 'pnpm lint *', 'pnpm typecheck', 'git status', 'git diff'];
  const tree = [dir('src'), file('src/app.ts'), file('src/util.ts'), file('package.json')];
  const prompt = buildSessionPrompt({ projectName: 'demo', tree, allowlist });

  it('matches the snapshot', () => {
    expect(prompt).toMatchSnapshot();
  });

  it('keeps the rules before the tree, under 1,500 characters', () => {
    const before = prompt.slice(0, prompt.indexOf('PROJECT FILES'));
    expect(before.length).toBeLessThan(1_500);
    expect(prompt.indexOf('RULES')).toBeLessThan(prompt.indexOf('PROJECT FILES'));
    expect(prompt.endsWith('Reply with only "Ready." to this message.')).toBe(true);
  });

  it('teaches every marker, in backticks, with the complete-file rule', () => {
    for (const marker of [
      '`@@FILE src/app.ts@@`',
      '`@@READ path@@`',
      '`@@RUN npm test@@`',
      '`@@DELETE path@@`',
      '`@@RENAME old/path -> new/path@@`',
      '`@@DONE@@`',
      '`@@CONTEXT path@@`'
    ]) {
      expect(prompt).toContain(marker);
    }
    expect(prompt).toContain('Never send partial files, diffs, or "rest unchanged" comments.');
    expect(prompt).toContain('Every marker starts AND ends with @@');
  });

  it('includes the project name and tree', () => {
    expect(prompt).toContain('"demo"');
    expect(prompt).toContain('PROJECT FILES\n```\nsrc/\n  app.ts\n  util.ts\npackage.json\n```');
  });

  it('lists exactly the allowlist, explaining * only when an entry has one', () => {
    expect(prompt).toContain(
      'Only these are allowed: `pnpm test`, `pnpm lint *`, `pnpm typecheck`, `git status`, `git diff` (`*`: you may add arguments there)'
    );
    const exact = buildSessionPrompt({ projectName: 'demo', tree, allowlist: ['pnpm test'] });
    expect(exact).toContain('Only these are allowed: `pnpm test`\n');
  });

  it('tells the chat not to ask for commands when none are allowed', () => {
    const none = buildSessionPrompt({ projectName: 'demo', tree: [file('a.ts')] });
    expect(none).not.toContain('@@RUN');
    expect(none).toContain("Bridge can't run commands in this project");
  });

  it('says when folders are summarised', () => {
    const cut = buildSessionPrompt({ projectName: 'demo', tree, truncated: true });
    expect(cut).toContain('PROJECT FILES (some folders are summarised');
  });

  it('never names a vendor', () => {
    expect(prompt).not.toMatch(/openai|chatgpt|codex|gpt/i);
  });

  it('pins what an echoed prompt would parse as', () => {
    // A user message, which Bridge never parses. If it were, only the FILE example (on its
    // own line, with a block) would count; the other examples sit inside sentences.
    const parsed = parseChat(prompt);
    expect(parsed.edits.map((e) => e.path)).toEqual(['src/app.ts']);
    expect(parsed).toMatchObject({ reads: [], runs: [], deletes: [], renames: [], done: false });
    expect(parsed.issues).toEqual([]);
  });
});

describe('FORMAT_FOOTER', () => {
  it('ends every message Bridge inserts for the chat', () => {
    const context = buildContextMessage([{ path: 'a.ts', content: 'a\n' }]).text;
    expect(context.endsWith(`\n\n${FORMAT_FOOTER}`)).toBe(true);
    expect(buildRunMessage(result).text).toBe(
      `${formatRunResult(result).text}\n\n${FORMAT_FOOTER}`
    );
    const followUp = buildFollowUp({
      applied: ['a.ts'],
      skipped: [],
      files: [{ path: 'b.ts', content: 'b\n' }],
      refused: [],
      runs: [{ command: 'pnpm test', result }]
    });
    expect(followUp?.text.endsWith(`\n\n${FORMAT_FOOTER}`)).toBe(true);
    // Once, even though the follow-up holds files and a command result.
    expect(followUp?.text.split(FORMAT_FOOTER)).toHaveLength(2);
  });

  it('is the exact line, and adds nothing to an empty message', () => {
    expect(FORMAT_FOOTER).toBe(
      'Bridge format: @@FILE path@@ + full code block · @@READ path@@ · @@RUN cmd@@ · @@DONE@@. Markers start and end with @@, in backticks.'
    );
    expect(buildContextMessage([]).text).toBe('');
  });

  it('counts toward the follow-up budget', () => {
    const input = {
      applied: [],
      skipped: [],
      files: [{ path: 'a.ts', content: 'x'.repeat(100) }],
      refused: [],
      runs: []
    };
    const fits = buildFollowUp(input)!;
    expect(buildFollowUp(input, fits.text.length)?.trimmed).toBe(false);
    expect(buildFollowUp(input, fits.text.length - 1)?.trimmed).toBe(true);
  });

  it('neither the footer nor the reminder reads as a request or a format issue', () => {
    for (const text of [FORMAT_FOOTER, FORMAT_REMINDER]) {
      expect(parseChat(text)).toMatchObject({
        edits: [],
        reads: [],
        runs: [],
        done: false,
        issues: []
      });
    }
  });
});

describe('formatRunResult', () => {
  it('shows the command, how it ended and the output in a fence', () => {
    expect(formatRunResult(result).text).toBe(
      'Output of `pnpm test` (exit 1, 3.2s):\n```text\nFAIL src/a.test.ts\n  expected 1 to be 2\n```'
    );
  });

  it.each([
    [{ status: 'timed-out', exitCode: null, signal: 'SIGTERM' }, 'timed out after 3.2s'],
    [{ status: 'cancelled', exitCode: null, signal: 'SIGTERM' }, 'cancelled after 3.2s'],
    [{ status: 'failed', exitCode: null, signal: null }, "couldn't start"],
    [{ status: 'exited', exitCode: null, signal: 'SIGKILL' }, 'ended by SIGKILL, 3.2s']
  ] as const)('says %j', (patch, words) => {
    expect(formatRunResult({ ...result, ...patch }).text).toContain(`(${words})`);
  });

  it('cuts long output in the middle and survives backticks in it', () => {
    const output = `start\n${'x\n'.repeat(10_000)}\`\`\`\nend\n`;
    const { text } = formatRunResult({ ...result, output }, 500);
    expect(text).toContain('[truncated]');
    expect(text).toContain('start');
    expect(text).toContain('end');
    expect(text).toContain('````text');
    expect(text.length).toBeLessThan(700);
  });

  it('says when there was no output', () => {
    expect(formatRunResult({ ...result, output: '' }).text).toContain('(no output)');
  });
});

describe('buildFollowUp', () => {
  const base = {
    applied: ['src/a.ts'],
    skipped: [{ path: 'package.json', reason: 'gated file' }],
    files: [{ path: 'b.ts', content: 'export const b = 1;\n' }],
    refused: [{ path: '.env', reason: 'protected file' }],
    runs: [
      { command: 'pnpm test', result },
      { command: 'rm -rf /', refused: 'not on the allowlist' }
    ]
  };

  it('puts the summary, the files and each command in one message', () => {
    const built = buildFollowUp(base);
    expect(built?.trimmed).toBe(false);
    const text = built?.text ?? '';
    expect(text).toContain('Applied: src/a.ts.');
    expect(text).toContain('Not applied: package.json (gated file).');
    expect(text).toContain('`@@CONTEXT b.ts@@`');
    expect(text).toContain('Bridge could not send: .env (protected file).');
    expect(text).toContain('Output of `pnpm test` (exit 1, 3.2s)');
    expect(text).toContain("Bridge didn't run `rm -rf /`: not on the allowlist");
    // A user message, but if it were parsed it would hold no edits or commands.
    expect(parseChat(text)).toMatchObject({ edits: [], runs: [], done: false });
  });

  it('cuts command output harder, then leaves files out, to fit the budget', () => {
    const big = {
      ...base,
      files: [{ path: 'big.ts', content: 'y'.repeat(20_000) }],
      runs: [{ command: 'pnpm test', result: { ...result, output: 'z\n'.repeat(20_000) } }]
    };
    const trimmedOutput = buildFollowUp(big, 25_000);
    expect(trimmedOutput?.trimmed).toBe(true);
    expect(trimmedOutput?.text).toContain('`@@CONTEXT big.ts@@`');
    expect(trimmedOutput?.text).toContain('(Bridge trimmed this message to fit.)');
    expect(trimmedOutput!.text.length).toBeLessThanOrEqual(25_000);

    const noFiles = buildFollowUp(big, 8_000);
    expect(noFiles?.text).not.toContain('@@CONTEXT');
    expect(noFiles?.text).toContain('Bridge left out the files you asked for (big.ts)');
  });

  it('gives up when even the trimmed message is over budget', () => {
    expect(buildFollowUp(base, 50)).toBeNull();
  });
});
