import { describe, expect, it } from 'vitest';
import {
  LOOP_MIN_SEND_GAP_MS,
  type BridgeConfig,
  type LoopReport,
  type RunResult
} from '@bridge/shared';
import {
  FullAutoLoop,
  SEND_CONFIRM_MS,
  type EditHold,
  type LoopPage,
  type ReplyActions,
  type RunOutcome
} from './loop';

const CONFIG: BridgeConfig = {
  mode: 'full-auto',
  allowlist: ['pnpm test'],
  stepLimit: 10,
  pauseOnFailure: false,
  running: null
};

const result = (exitCode: number, output = 'ok'): RunResult => ({
  runId: 'r',
  argv: ['pnpm', 'test'],
  status: 'exited',
  exitCode,
  signal: null,
  durationMs: 1000,
  output,
  truncated: false
});

/** A chat page in memory. Sending adds a user turn unless `sendWorks` is false. */
function fakePage() {
  const page = {
    conversation: 'conv-1' as string | null,
    turns: 1,
    composer: '',
    sent: [] as string[],
    sendWorks: true,
    hasButton: true,
    /** submit() calls that find no button yet, like the real page right after a paste. */
    buttonLate: 0,
    /** The page keeps nearby turns only: sending doesn't change the count Bridge sees. */
    virtualized: false,
    banner: null as string | null,
    insertWorks: true
  };
  const api: LoopPage = {
    conversationId: () => page.conversation,
    userTurns: () => page.turns,
    composerText: () => page.composer,
    insert: (text) => {
      if (!page.insertWorks) return { ok: false, error: 'not-inserted' };
      page.composer += text;
      return { ok: true, method: 'paste', chars: text.length };
    },
    submit: () => {
      if (!page.hasButton) return false;
      if (page.buttonLate > 0) {
        page.buttonLate -= 1;
        return false;
      }
      if (page.sendWorks) {
        page.sent.push(page.composer);
        page.composer = '';
        if (!page.virtualized) page.turns += 1;
      }
      return true;
    },
    error: () => page.banner
  };
  return { page, api };
}

interface FakeReply {
  edits?: { applied?: string[]; held?: { path: string; hold: EditHold }[] };
  reads?: string[];
  runs?: {
    command: string;
    refusal?: string;
    outcome?: RunOutcome | (() => Promise<RunOutcome>);
  }[];
  done?: boolean;
}

function reply(spec: FakeReply = {}) {
  const log: string[] = [];
  const applied = spec.edits?.applied ?? [];
  const held = spec.edits?.held ?? [];
  const runs = spec.runs ?? [];
  const actions: ReplyActions = {
    hasActions: applied.length + held.length + (spec.reads?.length ?? 0) + runs.length > 0,
    done: spec.done ?? false,
    applyEdits: async (loopId) => {
      log.push(`apply:${loopId ?? '-'}`);
    },
    edits: () => ({
      applied: [...applied],
      held: held.map((h) => ({ ...h, reason: h.hold }))
    }),
    reads: spec.reads ?? [],
    readFiles: async () => {
      log.push('read');
      return {
        files: (spec.reads ?? []).map((path) => ({ path, content: `// ${path}\n` })),
        refused: [],
        disconnected: false
      };
    },
    markReadsSent: () => log.push('reads-sent'),
    runs: runs.map((r) => ({
      command: r.command,
      refusal: () => r.refusal ?? null,
      run: async () => {
        log.push(`run:${r.command}`);
        const outcome = r.outcome ?? { ok: true, result: result(0) };
        return typeof outcome === 'function' ? outcome() : outcome;
      }
    }))
  };
  return { actions, log, held };
}

function setup(config: Partial<BridgeConfig> = {}) {
  let clock = 100_000;
  const sleeps: number[] = [];
  let current: BridgeConfig | null = { ...CONFIG, ...config };
  const reports: LoopReport[] = [];
  let cancels = 0;
  let ids = 0;
  const { page, api } = fakePage();
  const loop = new FullAutoLoop({
    page: api,
    config: () => current,
    report: (r) => reports.push(r),
    cancelRun: () => {
      cancels += 1;
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    newId: () => `loop-${++ids}`
  });
  return {
    loop,
    page,
    reports,
    sleeps,
    setConfig: (c: BridgeConfig | null) => {
      current = c;
      loop.onConfig(c);
    },
    advance: (ms: number) => {
      clock += ms;
    },
    get cancels() {
      return cancels;
    },
    events: () => reports.flatMap((r) => (r.event ? [`${r.event.kind}: ${r.event.text}`] : []))
  };
}

/** Lets the loop's promise chain run to its next stop. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await new Promise((r) => setImmediate(r));
}

describe('FullAutoLoop', () => {
  it('runs several steps: apply, read, run, send, wait, again', async () => {
    const t = setup();
    const first = reply({
      edits: { applied: ['src/a.ts'] },
      reads: ['src/b.ts'],
      runs: [{ command: 'pnpm test', outcome: { ok: true, result: result(1, 'FAIL a') } }]
    });
    t.loop.onReply(first.actions);
    await settle();
    expect(first.log).toEqual(['apply:loop-1', 'read', 'run:pnpm test', 'reads-sent']);
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.loop.step).toBe(1);
    expect(t.page.sent).toHaveLength(1);
    const message = t.page.sent[0]!;
    expect(message).toContain('Applied: src/a.ts.');
    expect(message).toContain('`@@CONTEXT src/b.ts@@`');
    expect(message).toContain('Output of `pnpm test` (exit 1, 1.0s)');
    expect(message).toContain('FAIL a');

    const second = reply({
      edits: { applied: ['src/a.ts'] },
      runs: [{ command: 'pnpm test' }]
    });
    t.loop.onReply(second.actions);
    await settle();
    expect(t.loop.step).toBe(2);
    expect(t.page.sent[1]).toContain('(exit 0, 1.0s)');

    t.loop.onReply(reply().actions);
    expect(t.loop.state).toBe('idle');
    expect(t.events()).toEqual([
      'started: Full auto run started.',
      'applied: Applied 1 of 1 edits.',
      'ran: pnpm test: exit 1',
      'sent: Sent message 1 of 10.',
      'applied: Applied 1 of 1 edits.',
      'ran: pnpm test: passed',
      'sent: Sent message 2 of 10.',
      'done: The chat asked for nothing more.'
    ]);
    expect(new Set(t.reports.map((r) => r.loopId))).toEqual(new Set(['loop-1']));
  });

  it('ends on @@DONE@@ after applying that reply’s edits, without sending', async () => {
    const t = setup();
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    const done = reply({
      edits: { applied: ['src/a.ts'] },
      runs: [{ command: 'pnpm test' }],
      done: true
    });
    t.loop.onReply(done.actions);
    await settle();
    expect(done.log).toEqual(['apply:loop-1']);
    expect(t.loop.state).toBe('idle');
    expect(t.page.sent).toHaveLength(1);
    expect(t.events().at(-1)).toBe('done: The chat said it’s done.');
  });

  it('ends on a reply that is only @@DONE@@', async () => {
    const t = setup();
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    t.loop.onReply(reply({ done: true }).actions);
    expect(t.loop.state).toBe('idle');
    expect(t.events().at(-1)).toBe('done: The chat said it’s done.');
  });

  it('never starts on a reply with no actions, or one that is already done', async () => {
    const t = setup();
    t.loop.onReply(reply().actions);
    expect(t.loop.state).toBe('idle');
    const done = reply({ edits: { applied: ['a.ts'] }, done: true });
    t.loop.onReply(done.actions);
    await settle();
    expect(done.log).toEqual(['apply:-']);
    expect(t.loop.state).toBe('idle');
    expect(t.reports).toEqual([]);
  });

  it('does nothing outside Full auto', async () => {
    const t = setup({ mode: 'auto-apply' });
    const r = reply({ runs: [{ command: 'pnpm test' }] });
    t.loop.onReply(r.actions);
    await settle();
    expect(r.log).toEqual([]);
    expect(t.reports).toEqual([]);
  });

  it.each<[EditHold, string]>([
    ['gated', 'gated'],
    ['partial', 'partial'],
    ['conflict', 'conflict'],
    ['blocked', 'blocked']
  ])('pauses on a %s edit, then carries on after Resume', async (hold, reason) => {
    const t = setup();
    const r = reply({
      edits: { applied: ['src/a.ts'], held: [{ path: 'package.json', hold }] },
      runs: [{ command: 'pnpm test' }]
    });
    t.loop.onReply(r.actions);
    await settle();
    expect(t.loop.state).toBe('paused');
    expect(t.loop.reason).toBe(reason);
    expect(r.log).toEqual(['apply:loop-1']);
    expect(t.reports.at(-1)).toMatchObject({ state: 'paused', reason });

    t.loop.resume();
    await settle();
    expect(r.log).toEqual(['apply:loop-1', 'run:pnpm test', 'reads-sent']);
    expect(t.page.sent[0]).toContain(`Not applied: package.json (${hold}).`);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('pauses on a command that isn’t allowed, and reports it as refused after Resume', async () => {
    const t = setup();
    const r = reply({
      runs: [{ command: 'pnpm test' }, { command: 'rm -rf /', refusal: 'not on the allowlist' }]
    });
    t.loop.onReply(r.actions);
    await settle();
    expect(t.loop.reason).toBe('not-allowed');
    expect(r.log).toEqual(['apply:loop-1']);
    t.loop.resume();
    await settle();
    expect(r.log).toContain('run:pnpm test');
    expect(r.log).not.toContain('run:rm -rf /');
    expect(t.page.sent[0]).toContain("Bridge didn't run `rm -rf /`: not on the allowlist");
  });

  it('sends a failing command’s output to the chat by default', async () => {
    const t = setup();
    t.loop.onReply(
      reply({ runs: [{ command: 'pnpm test', outcome: { ok: true, result: result(1) } }] }).actions
    );
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.page.sent).toHaveLength(1);
  });

  it('pauses on a failing command when “Pause on failure” is on', async () => {
    const t = setup({ pauseOnFailure: true });
    const r = reply({
      runs: [
        { command: 'pnpm test', outcome: { ok: true, result: result(2) } },
        { command: 'pnpm lint' }
      ]
    });
    t.loop.onReply(r.actions);
    await settle();
    expect(t.loop.reason).toBe('failure');
    expect(r.log).toEqual(['apply:loop-1', 'run:pnpm test']);
    t.loop.resume();
    await settle();
    expect(r.log).toEqual(['apply:loop-1', 'run:pnpm test', 'run:pnpm lint', 'reads-sent']);
  });

  it('pauses when the follow-up is too big even trimmed, and Resume ends the run', async () => {
    const t = setup();
    const huge = 'x'.repeat(40_000);
    const r = reply({
      edits: { applied: Array.from({ length: 2000 }, (_, i) => `src/${huge.slice(0, 20)}${i}.ts`) }
    });
    t.loop.onReply(r.actions);
    await settle();
    expect(t.loop.reason).toBe('too-big');
    expect(t.page.sent).toEqual([]);
    t.loop.resume();
    expect(t.loop.state).toBe('idle');
  });

  it('pauses on an error banner, before sending and while waiting', async () => {
    const t = setup();
    t.page.banner = 'Something went wrong.';
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.reason).toBe('page-error');
    expect(t.page.sent).toEqual([]);

    t.page.banner = null;
    t.loop.resume();
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    t.page.banner = "You've reached our limit of messages.";
    t.loop.tick();
    expect(t.loop.reason).toBe('page-error');
  });

  it('pauses when the connection to the app goes, mid-step or while waiting', async () => {
    const t = setup();
    t.loop.onReply(
      reply({
        runs: [
          { command: 'pnpm test', outcome: { ok: false, disconnected: true, message: 'gone' } }
        ]
      }).actions
    );
    await settle();
    expect(t.loop.reason).toBe('disconnected');

    const u = setup();
    u.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    u.setConfig(null);
    expect(u.loop.reason).toBe('disconnected');
  });

  it('pauses when the user navigates away, and resumes only back in that conversation', async () => {
    const t = setup();
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    t.page.conversation = 'conv-2';
    t.loop.onNavigate('conv-2');
    expect(t.loop.reason).toBe('navigated');
    t.loop.resume();
    expect(t.loop.state).toBe('paused');
    t.page.conversation = 'conv-1';
    t.loop.resume();
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('pauses at the step limit and offers Continue for N more', async () => {
    const t = setup({ stepLimit: 2 });
    const step = () => reply({ runs: [{ command: 'pnpm test' }] }).actions;
    t.loop.onReply(step());
    await settle();
    t.loop.onReply(step());
    await settle();
    expect(t.loop.step).toBe(2);
    t.loop.onReply(step());
    await settle();
    expect(t.loop.state).toBe('paused');
    expect(t.loop.reason).toBe('step-limit');
    expect(t.page.sent).toHaveLength(2);
    expect(t.reports.at(-1)).toMatchObject({ step: 2, limit: 2, reason: 'step-limit' });

    t.loop.continueFor();
    await settle();
    expect(t.loop.limit).toBe(4);
    expect(t.loop.step).toBe(3);
    expect(t.page.sent).toHaveLength(3);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('stops halfway through a command: cancels it, drops its result, sends nothing', async () => {
    const t = setup();
    let finish: (outcome: RunOutcome) => void = () => {};
    const r = reply({
      runs: [
        {
          command: 'pnpm test',
          outcome: () => new Promise<RunOutcome>((resolve) => (finish = resolve))
        },
        { command: 'pnpm lint' }
      ]
    });
    t.loop.onReply(r.actions);
    await settle();
    expect(r.log).toEqual(['apply:loop-1', 'run:pnpm test']);
    t.loop.stop();
    expect(t.loop.state).toBe('stopped');
    expect(t.cancels).toBe(1);
    finish({ ok: true, result: { ...result(0), status: 'cancelled' } });
    await settle();
    expect(r.log).toEqual(['apply:loop-1', 'run:pnpm test']);
    expect(t.page.sent).toEqual([]);
    expect(t.events().at(-1)).toBe('stopped: Stopped.');

    // Stop is sticky: the next reply doesn't start a run until Resume.
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    expect(t.loop.state).toBe('stopped');
    t.loop.resume();
    expect(t.loop.state).toBe('idle');
  });

  it('pauses when a send never shows up as a new user turn, and Resume presses send again', async () => {
    const t = setup();
    t.page.sendWorks = false;
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.reason).toBe('send-failed');
    expect(t.page.composer).toContain('Output of `pnpm test`');
    expect(t.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(SEND_CONFIRM_MS);

    t.page.sendWorks = true;
    t.loop.resume();
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    // Inserted once, sent once: no duplicate text.
    expect(t.page.sent).toHaveLength(1);
    expect(t.page.sent[0]!.match(/Output of/g)).toHaveLength(1);
  });

  it('waits for a send button that appears a moment after the text goes in', async () => {
    const t = setup();
    t.page.buttonLate = 3;
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.page.sent).toHaveLength(1);
    expect(t.page.buttonLate).toBe(0);
  });

  it('counts a send by the composer emptying when the turn count doesn’t move', async () => {
    const t = setup();
    t.page.virtualized = true;
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.loop.step).toBe(1);
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.step).toBe(2);
  });

  it('takes a reply that arrives after a send it couldn’t confirm as proof, and carries on', async () => {
    const t = setup();
    t.page.sendWorks = false;
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.reason).toBe('send-failed');
    // The message did go out (the user pressed send, or the page didn't show it), and the
    // chat answered: the same run goes on, now at step 1.
    t.page.composer = '';
    t.page.sendWorks = true;
    const loopId = t.loop.loopId;
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.loopId).toBe(loopId);
    expect(t.loop.step).toBe(2);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('ends on a DONE reply that lands while a send is being confirmed', async () => {
    const t = setup();
    t.page.virtualized = true;
    t.page.sendWorks = false;
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    // While it waits to see the send land, the chat already answered DONE.
    await new Promise((r) => setImmediate(r));
    t.loop.onReply(reply({ done: true }).actions);
    await settle();
    expect(t.loop.state).toBe('idle');
    expect(t.events().at(-1)).toBe('done: The chat said it’s done.');
  });

  it('pauses when there is no send button or the composer refuses the text', async () => {
    const t = setup();
    t.page.hasButton = false;
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.reason).toBe('send-failed');

    const u = setup();
    u.page.insertWorks = false;
    u.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(u.loop.reason).toBe('send-failed');
  });

  it('waits at least 3s between sends, and adds no other delay', async () => {
    const t = setup();
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.sleeps).toEqual([]);
    t.advance(1_200);
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.sleeps).toEqual([LOOP_MIN_SEND_GAP_MS - 1_200]);
    t.advance(10_000);
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.sleeps).toEqual([LOOP_MIN_SEND_GAP_MS - 1_200]);
    expect(t.page.sent).toHaveLength(3);
  });

  it('ends the run when Full auto is turned off, and cancels its command', async () => {
    const t = setup();
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    t.setConfig({ ...CONFIG, mode: 'manual' });
    expect(t.loop.state).toBe('idle');
    expect(t.cancels).toBe(1);
    expect(t.events().at(-1)).toBe('stopped: Full auto was turned off.');
  });

  it('a reply that arrives while paused ends that run and may start the next', async () => {
    const t = setup({ pauseOnFailure: true });
    t.loop.onReply(
      reply({ runs: [{ command: 'pnpm test', outcome: { ok: true, result: result(1) } }] }).actions
    );
    await settle();
    expect(t.loop.state).toBe('paused');
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.loop.loopId).toBe('loop-2');
    expect(t.events()).toContain('done: A new reply arrived while paused, so that run ended.');
  });
});
