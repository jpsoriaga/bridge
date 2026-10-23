import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  checkArgv,
  commandRefusal,
  deniedArgument,
  matchAllowlist,
  parseAllowlistEntry,
  parseCommand
} from './commands';
import { parseChat } from './parser';
import {
  ClientMessage,
  PairConfirmRequest,
  PairRequest,
  parseMessage,
  PROTOCOL_VERSION,
  ServerMessage
} from './protocol';
import { redactSecrets } from './redact';

// Thousands of runs per property take about a second here, but can pass 5s on a busy CI
// runner under coverage.
vi.setConfig({ testTimeout: 30_000 });

// Property tests: random input, thousands of times, for the code that turns untrusted text
// (chat replies, commands, socket messages) into structure.

/** Text that looks like chat replies: markers, fences, backticks, @@, odd whitespace. */
const chatText = fc
  .array(
    fc.oneof(
      fc.string(),
      fc.constantFrom(
        '@@FILE ',
        '@@READ ',
        '@@RUN ',
        '@@DELETE ',
        '@@RENAME ',
        ' -> ',
        '→',
        '@@CONTEXT ',
        '@@DONE@@',
        '@@',
        '`',
        '```',
        '````',
        '~~~',
        '\n',
        '\r\n',
        '- ',
        '1. ',
        '../',
        '/etc/passwd',
        ' '
      )
    ),
    { maxLength: 60 }
  )
  .map((parts) => parts.join(''));

/** What a path or command from a marker can look like. */
function wellFormed(value: string): boolean {
  return (
    value.length > 0 && value === value.trim() && !/[\n\r`]/.test(value) && !value.includes('@@')
  );
}

describe('parseChat (property)', () => {
  it('never throws, and every path and command it returns is one marker’s text', () => {
    fc.assert(
      fc.property(fc.oneof(chatText, fc.string(), fc.string({ unit: 'grapheme' })), (text) => {
        const parsed = parseChat(text);
        for (const value of [
          ...parsed.edits.map((e) => e.path),
          ...parsed.reads,
          ...parsed.runs,
          ...parsed.deletes,
          ...parsed.renames.flatMap((r) => [r.from, r.to])
        ]) {
          expect(wellFormed(value), JSON.stringify(value)).toBe(true);
        }
        for (const edit of parsed.edits) {
          expect(edit.content.endsWith('\n') || edit.content === '').toBe(true);
          expect(edit.fence).toBeGreaterThanOrEqual(0);
        }
        expect(new Set(parsed.reads).size).toBe(parsed.reads.length);
      }),
      { numRuns: 3000 }
    );
  });

  it('finds a well-formed FILE block wherever it sits', () => {
    const path = fc
      .array(fc.constantFrom('a', 'b', 'src', 'x.ts', 'dir with space', 'é'), {
        minLength: 1,
        maxLength: 4
      })
      .map((parts) => parts.join('/'));
    fc.assert(
      fc.property(fc.string(), path, fc.string(), (before, file, body) => {
        fc.pre(!/`{3,}|~{3,}|@@/.test(before + body) && !body.includes('`'));
        const text = `${before.replace(/@/g, '')}\n\n\`@@FILE ${file}@@\`\n\`\`\`\n${body}\n\`\`\`\n`;
        const edits = parseChat(text).edits;
        expect(edits.at(-1)?.path).toBe(file);
      }),
      { numRuns: 1000 }
    );
  });
});

describe('parseCommand and the allowlist (property)', () => {
  const word = fc.oneof(
    fc.string({ maxLength: 12 }),
    fc.constantFrom(
      'pnpm',
      'git',
      'node',
      'npx',
      'test',
      '-C',
      '--',
      '-e',
      '|',
      '&&',
      ';',
      '$(id)',
      '`id`',
      '*',
      '"a b"',
      "'x'",
      '>',
      '#'
    )
  );
  const commandText = fc.array(word, { maxLength: 8 }).map((words) => words.join(' '));

  it('never throws, and argv it returns passes the desktop’s per-word re-check', () => {
    fc.assert(
      fc.property(fc.oneof(commandText, fc.string()), (text) => {
        const parsed = parseCommand(text);
        if (parsed.ok) {
          expect(checkArgv(parsed.argv)).toBeNull();
          expect(parsed.argv.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 3000 }
    );
  });

  it('allows argv only when an entry’s words lead it: all of it if exact, a prefix with *', () => {
    fc.assert(
      fc.property(commandText, commandText, fc.boolean(), (entryText, argvText, extra) => {
        const entry = extra ? `${entryText} *` : entryText;
        const rule = parseAllowlistEntry(entry);
        const parsed = parseCommand(argvText);
        fc.pre(rule !== null && parsed.ok);
        const matched = matchAllowlist(parsed.argv, [entry]) !== null;
        const leads = rule.words.every((w, i) => parsed.argv[i] === w);
        const fits = rule.extra
          ? rule.words.length <= parsed.argv.length
          : rule.words.length === parsed.argv.length;
        expect(matched).toBe(leads && fits);
      }),
      { numRuns: 3000 }
    );
  });

  it('extending an allowed exact command is refused; extending a * one is allowed', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('pnpm', 'test', 'lint', 'run'), { minLength: 1, maxLength: 3 }),
        fc.array(fc.constantFrom('--watch', 'src', '-u', 'x'), { minLength: 1, maxLength: 3 }),
        (base, more) => {
          const command = base.join(' ');
          expect(matchAllowlist([...base, ...more], [command])).toBeNull();
          expect(matchAllowlist([...base, ...more], [`${command} *`])).toBe(`${command} *`);
        }
      )
    );
  });

  it('never lets a denied option through, whatever the allowlist', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('git', 'node', 'npm', 'pnpm', 'yarn', 'npx'),
        fc.array(
          fc.constantFrom(
            'status',
            'test',
            '-C',
            '-e',
            '--eval=1',
            'dlx',
            '--output=x',
            'a.js',
            '-pe',
            '--dir=/'
          ),
          { maxLength: 5 }
        ),
        (program, args) => {
          const argv = [program, ...args];
          if (commandRefusal(argv, [`${program} *`]) === null) {
            expect(deniedArgument(argv)).toBeNull();
          } else {
            expect(deniedArgument(argv)).not.toBeNull();
          }
        }
      ),
      { numRuns: 2000 }
    );
  });
});

describe('protocol schemas (property)', () => {
  const envelope = fc.record(
    {
      v: fc.oneof(fc.constant(PROTOCOL_VERSION), fc.integer()),
      id: fc.oneof(fc.string({ maxLength: 70 }), fc.integer()),
      type: fc.oneof(
        fc.constantFrom(
          'hello',
          'auth',
          'ping',
          'read',
          'write',
          'run',
          'status',
          'challenge',
          'response'
        ),
        fc.string()
      ),
      payload: fc.oneof(fc.object(), fc.jsonValue())
    },
    { requiredKeys: [] }
  );

  it('parseMessage never throws, and whatever it accepts round-trips unchanged', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          envelope.map((e) => JSON.stringify(e))
        ),
        (text) => {
          for (const schema of [ClientMessage, ServerMessage]) {
            const parsed = parseMessage(schema, text);
            if (parsed) {
              expect(parsed.v).toBe(PROTOCOL_VERSION);
              expect(parseMessage(schema, JSON.stringify(parsed))).toEqual(parsed);
            }
          }
        }
      ),
      { numRuns: 3000 }
    );
  });

  it('pairing bodies accept only their exact shape', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const pair = PairRequest.safeParse(value);
        if (pair.success) {
          expect(Object.keys(pair.data).sort()).toEqual(['code', 'publicKey']);
          expect(pair.data.code).toMatch(/^\d{6}$/);
        }
        const confirm = PairConfirmRequest.safeParse(value);
        if (confirm.success) expect(confirm.data.proof).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 2000 }
    );
  });
});

describe('redactSecrets (property)', () => {
  it('never throws, never grows a secret back, and is stable on its own output', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const once = redactSecrets(text);
        const twice = redactSecrets(once.text);
        expect(twice.text).toBe(once.text);
        expect(twice.count).toBe(0);
      }),
      { numRuns: 2000 }
    );
  });
});
