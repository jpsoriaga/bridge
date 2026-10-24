import { describe, expect, it } from 'vitest';
import type { TreeEntry } from './files';
import { parseChat } from './parser';
import { failureSignature, stepText } from './loop';
import {
  buildContextMessage,
  buildContinuation,
  buildFollowUp,
  buildLogsMessage,
  LOGS_LINES,
  buildRunMessage,
  buildAllowlistNote,
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

  it('keeps the rules before the tree, under 1,700 characters', () => {
    const before = prompt.slice(0, prompt.indexOf('PROJECT FILES'));
    expect(before.length).toBeLessThan(1_700);
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

  it('asks for the install command after package.json changes, only when it’s allowed', () => {
    const line = 'After changing package.json, run the install command: `@@RUN pnpm install@@`';
    expect(prompt).not.toContain('After changing package.json');
    const withInstall = buildSessionPrompt({
      projectName: 'demo',
      tree,
      allowlist: ['pnpm install', ...allowlist]
    });
    expect(withInstall).toContain(line);
    expect(withInstall.slice(0, withInstall.indexOf('PROJECT FILES')).length).toBeLessThan(1_700);
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

describe('continuation', () => {
  it('names the last complete marker and the cut-off file', () => {
    expect(
      buildContinuation({ marker: '@@FILE src/components/Hero.tsx@@', cutOff: 'src/app.ts' })
    ).toBe(
      `Your last reply was cut off after @@FILE src/components/Hero.tsx@@. Continue from there using Bridge's format. Resend src/app.ts in full if it was cut off. Don't repeat files that were already complete.\n\n${FORMAT_FOOTER}`
    );
  });

  it('leaves out the resend line without a cut-off file, and copes with no marker', () => {
    const text = buildContinuation({ marker: null, cutOff: null });
    expect(text).toContain('Your last reply was cut off before its first Bridge marker.');
    expect(text).not.toContain('Resend');
    expect(parseChat(text)).toMatchObject({ edits: [], reads: [], runs: [], issues: [] });
  });

  it('ends a Full auto follow-up, after the results, and says when a command was skipped', () => {
    const built = buildFollowUp({
      applied: ['src/one.ts'],
      skipped: [],
      files: [],
      refused: [],
      runs: [{ command: 'pnpm test', skipped: true }],
      continuation: { marker: '@@FILE src/one.ts@@', cutOff: 'src/two.ts' }
    })!.text;
    expect(built.indexOf('The command `pnpm test` was interrupted and skipped.')).toBeLessThan(
      built.indexOf('Your last reply was cut off after @@FILE src/one.ts@@.')
    );
    expect(built.endsWith(FORMAT_FOOTER)).toBe(true);
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

describe('1.3.0: background processes, logs, attachments', () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const empty = { applied: [], skipped: [], files: [], refused: [], runs: [] };

  it('puts the dev servers in their own rule, out of the @@RUN list', () => {
    const prompt = buildSessionPrompt({
      projectName: 'demo',
      tree: [],
      allowlist: ['npm test', 'npm install', 'npm run dev'],
      background: ['npm run dev']
    });
    expect(prompt).toContain('Only these are allowed: `npm test`, `npm install`');
    expect(prompt).toContain('`@@START npm run dev@@`, `@@STOP npm run dev@@`');
    expect(prompt).toContain('`@@LOGS npm run dev@@`');
    expect(prompt).toContain('`@@ASSET public/hero.png@@`');
    expect(prompt).toContain('@@DOWNLOAD');
    const before = prompt.slice(0, prompt.indexOf('PROJECT FILES'));
    expect(before.length).toBeLessThan(1_850);
  });

  it('says how each START and STOP went, with the URL', () => {
    const built = buildFollowUp({
      ...empty,
      processes: [
        { command: 'npm run dev', started: true, url: 'http://localhost:5173/' },
        { command: 'npm run dev', started: true, restarted: true, url: null },
        { command: 'npm run api', stopped: true },
        { command: 'npm run docs', stopped: false },
        { command: 'npm run web', exited: 'exited with code 1', lines: ['Error: port in use'] },
        { command: 'npm run x', refused: 'it isn’t on the allowlist' }
      ]
    })!;
    expect(built.text).toContain(
      'Started `npm run dev` in the background, running at http://localhost:5173/.'
    );
    expect(built.text).toContain('Restarted `npm run dev` in the background.');
    expect(built.text).toContain('Stopped `npm run api`.');
    expect(built.text).toContain("`npm run docs` wasn't running.");
    expect(built.text).toContain('`npm run web` exited with code 1 right after starting:');
    expect(built.text).toContain('Error: port in use');
    expect(built.text).toContain("Bridge didn't start `npm run x`: it isn’t on the allowlist");
  });

  it('sends logs and errors redacted, and counts what it replaced', () => {
    const built = buildFollowUp({
      ...empty,
      logs: [
        { command: 'npm run dev', lines: ['ready', `token=${token}`], url: 'http://localhost:3000' }
      ],
      errors: [{ command: 'npm run dev', lines: [`Error: bad key ${token}`] }]
    })!;
    expect(built.text).toContain(
      'Last 2 lines of `npm run dev`, running at http://localhost:3000:'
    );
    expect(built.text).toContain('`npm run dev` printed errors after these edits:');
    expect(built.text).not.toContain(token);
    expect(built.redacted).toBe(2);
    expect(built.text.endsWith(FORMAT_FOOTER)).toBe(true);
  });

  it(`sends at most the last ${LOGS_LINES} lines of a log`, () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const { text } = buildLogsMessage({ command: 'npm run dev', lines });
    expect(text).toContain(`Last ${LOGS_LINES} lines of \`npm run dev\``);
    expect(text).toContain('line 199');
    expect(text).not.toContain('line 119\n');
    expect(text.endsWith(FORMAT_FOOTER)).toBe(true);
    expect(buildLogsMessage({ command: 'x', lines: [token] }).redacted).toBe(1);
  });

  it('names the images that went with the message', () => {
    expect(buildFollowUp({ ...empty, attached: ['public/hero.png'] })!.text).toContain(
      'Attached image: public/hero.png.'
    );
    expect(buildContextMessage([], [], ['a.png', 'b.png']).text).toContain(
      'Attached images: a.png, b.png.'
    );
  });

  it('puts a format reminder first, with the files the reply asked for', () => {
    const built = buildFollowUp({
      ...empty,
      reminder: FORMAT_REMINDER,
      files: [{ path: 'a.ts', content: 'x\n' }]
    })!;
    expect(built.text.startsWith(FORMAT_REMINDER)).toBe(true);
    expect(built.text).toContain('@@CONTEXT a.ts@@');
  });
});

describe('loop words', () => {
  it('reads a step with or without a limit', () => {
    expect(stepText(3, 25)).toBe('Step 3 of 25');
    expect(stepText(3, null)).toBe('Step 3');
  });

  it('compares failures without their timings', () => {
    const a = failureSignature('exit 1', 'FAIL a.test.ts\n  expected 1 to be 2\nDuration 1.21s');
    const b = failureSignature('exit 1', 'FAIL a.test.ts\n  expected 1 to be 2\nDuration 3.07s');
    const c = failureSignature('exit 1', 'FAIL b.test.ts\n  expected 1 to be 2\nDuration 3.07s');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(failureSignature('exit 2', 'x')).not.toBe(failureSignature('exit 1', 'x'));
  });
});

describe('buildAllowlistNote', () => {
  it('lists what the chat may run now, and which are background', () => {
    expect(buildAllowlistNote(['pnpm test', 'pnpm dev'], ['pnpm dev'])).toBe(
      'Note: I changed the commands Bridge may run. With `@@RUN cmd@@`: `pnpm test`. In the background, with `@@START cmd@@`, `@@STOP cmd@@` and `@@LOGS cmd@@`: `pnpm dev`.'
    );
    expect(buildAllowlistNote([], [])).toBe(
      "Note: I changed the commands Bridge may run. Bridge can't run any commands now."
    );
  });
});
