import { describe, expect, it } from 'vitest';
import {
  FORMAT_REMINDER,
  LOOP_GUARD_REPEATS,
  LOOP_MIN_SEND_GAP_MS,
  STALL_MS,
  type BridgeConfig,
  type FollowUpProcess,
  type LoopReport,
  type ProcessLines,
  type RunResult
} from '@bridge/shared';
import {
  ATTACH_SEND_WAIT_MS,
  FullAutoLoop,
  INTERRUPT_GRACE_MS,
  PROCESS_SETTLE_MS,
  MAX_FORMAT_REMINDERS,
  SEND_CONFIRM_MS,
  WAKE_WINDOW_MS,
  type EditHold,
  type LoopPage,
  type ReplyActions,
  type ReplyInterruption,
  type ReplyStatus,
  type RunOutcome
} from './loop';

const CONFIG: BridgeConfig = {
  mode: 'full-auto',
  allowlist: ['pnpm test'],
  stepLimit: 10,
  pauseOnFailure: false,
  catchUpAfterSleep: true,
  uiGuidance: 'auto',
  running: null,
  background: [],
  processes: [],
  autoApprove: { changes: false, gated: false, partial: false },
  instance: 'launch-1'
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
    insertWorks: true,
    /** The newest reply: its state and how much text it has so far. */
    status: 'complete' as ReplyStatus,
    length: 100,
    /** Presses of the page's stop button and its Continue generating. */
    stops: 0,
    continues: 0,
    canStop: true,
    canContinue: false,
    online: true,
    /** Images attached with each message, and whether attaching works. */
    attached: [] as string[][],
    attachWorks: true
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
    attach: (images) => {
      if (!page.attachWorks) return false;
      page.attached.push(images.map((image) => image.name));
      return true;
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
    error: () => page.banner,
    replyStatus: () => page.status,
    replyLength: () => page.length,
    stopReply: () => {
      if (!page.canStop) return false;
      page.stops += 1;
      page.status = 'complete';
      return true;
    },
    continueReply: () => {
      if (!page.canContinue) return false;
      page.continues += 1;
      page.status = 'streaming';
      return true;
    },
    online: () => page.online
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
  /** Deletes and renames. Mutate `pending`/`applied` to stand for a click. */
  changes?: { applied: string[]; pending: string[] };
  /** The reply missed Bridge's format somewhere. */
  formatIssues?: boolean;
  /** The reply was cut off. */
  interruption?: Partial<ReplyInterruption>;
  /** Images the reply's READs found, attached to the follow-up. */
  images?: string[];
  /** `@@START` / `@@STOP`, each with what it comes to. */
  processes?: {
    kind: 'start' | 'stop';
    command: string;
    refusal?: string;
    outcome?: FollowUpProcess | { disconnected: true };
  }[];
  /** `@@LOGS`, with the lines each reads (or why not). */
  logs?: { command: string; lines?: string[]; refused?: string }[];
  /** Downloads: mutate to stand for a click. */
  downloads?: { applied: string[]; pending: string[] };
  /** Each edit's path and content hash, for the loop guard. */
  fingerprints?: { path: string; hash: string }[];
  /** Error lines the dev servers print after the edits. */
  errors?: ProcessLines[];
}

function reply(spec: FakeReply = {}) {
  const log: string[] = [];
  const applied = spec.edits?.applied ?? [];
  const held = spec.edits?.held ?? [];
  const runs = spec.runs ?? [];
  const actions: ReplyActions = {
    hasActions:
      applied.length +
        held.length +
        (spec.reads?.length ?? 0) +
        runs.length +
        (spec.changes ? spec.changes.applied.length + spec.changes.pending.length : 0) +
        (spec.processes?.length ?? 0) +
        (spec.logs?.length ?? 0) +
        (spec.downloads ? spec.downloads.applied.length + spec.downloads.pending.length : 0) >
      0,
    done: spec.done ?? false,
    formatIssues: spec.formatIssues ?? false,
    markReminded: () => log.push('reminded'),
    applyEdits: async (loopId) => {
      log.push(`apply:${loopId ?? '-'}`);
    },
    edits: () => ({
      applied: [...applied],
      held: held.map((h) => ({ ...h, reason: h.hold }))
    }),
    changes: () => ({
      applied: [...(spec.changes?.applied ?? [])],
      pending: [...(spec.changes?.pending ?? [])]
    }),
    reads: spec.reads ?? [],
    readFiles: async () => {
      log.push('read');
      return {
        files: (spec.reads ?? [])
          .filter((path) => !(spec.images ?? []).includes(path))
          .map((path) => ({ path, content: `// ${path}\n` })),
        images: (spec.images ?? []).map((path) => ({
          path,
          name: path.split('/').pop()!,
          mime: 'image/png',
          data: 'iVBORw0K'
        })),
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
    })),
    interruption: spec.interruption
      ? { marker: null, cutOff: null, pageContinue: false, ...spec.interruption }
      : null,
    ...(spec.processes && {
      processes: spec.processes.map((p) => ({
        kind: p.kind,
        command: p.command,
        refusal: () => p.refusal ?? null,
        act: async () => {
          log.push(`${p.kind}:${p.command}`);
          return (
            p.outcome ??
            (p.kind === 'start'
              ? { command: p.command, started: true as const, url: 'http://localhost:5173/' }
              : { command: p.command, stopped: true })
          );
        }
      }))
    }),
    ...(spec.logs && {
      logs: spec.logs.map((l) => ({
        command: l.command,
        read: async () => {
          log.push(`logs:${l.command}`);
          return l.refused ? { refused: l.refused } : { command: l.command, lines: l.lines ?? [] };
        }
      }))
    }),
    ...(spec.downloads && { downloads: () => ({ ...spec.downloads! }) }),
    ...(spec.fingerprints && { fingerprints: spec.fingerprints }),
    ...(spec.errors && {
      logCursor: async () => {
        log.push('cursor');
        return [{ command: 'npm run dev', next: 10 }];
      },
      processErrors: async () => {
        log.push('errors');
        return spec.errors!;
      }
    })
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

  it('still sends a follow-up with redactions, and logs how many', async () => {
    const t = setup();
    // Assembled at runtime: not a real token, and nothing for a secret scanner to find.
    const token = `gh${'p_'}Q7f2Kp9xZ3mW8vR1tY6uN4bL0cJ5hG2dabcd`;
    t.loop.onReply(
      reply({
        runs: [{ command: 'pnpm test', outcome: { ok: true, result: result(0, `env ${token}`) } }]
      }).actions
    );
    await settle();
    expect(t.page.sent).toHaveLength(1);
    expect(t.page.sent[0]).toContain('[redacted]');
    expect(t.page.sent[0]).not.toContain(token);
    expect(t.events()).toContain('sent: Sent message 1 of 10, with 1 likely secret redacted.');
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

  it('pauses for deletes and renames, which only a click applies, then carries on', async () => {
    const t = setup();
    const changes = { applied: [] as string[], pending: ['old.ts (deleted)'] };
    const r = reply({ edits: { applied: ['a.ts'] }, changes });
    t.loop.onReply(r.actions);
    await settle();
    expect(t.loop.state).toBe('paused');
    expect(t.loop.reason).toBe('needs-click');
    expect(t.page.sent).toHaveLength(0);

    // The user clicks Delete on the card, then Resume.
    changes.pending = [];
    changes.applied = ['old.ts (deleted)'];
    t.loop.resume();
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.page.sent[0]).toContain('Applied: a.ts, old.ts (deleted).');
  });

  it('reports a delete left unclicked as not applied', async () => {
    const t = setup();
    const r = reply({
      runs: [{ command: 'pnpm test' }],
      changes: { applied: [], pending: ['x.ts (deleted)'] }
    });
    t.loop.onReply(r.actions);
    await settle();
    expect(t.loop.reason).toBe('needs-click');
    t.loop.resume();
    await settle();
    expect(t.page.sent[0]).toContain('Not applied: x.ts (deleted) (not confirmed).');
  });

  it('pauses with “app restarted” when the app comes back as a new launch, until Full auto is on again', async () => {
    const t = setup();
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    t.setConfig(null);
    expect(t.loop.reason).toBe('disconnected');
    // The app restarted: a new instance, back in Manual.
    t.setConfig({ ...CONFIG, mode: 'manual', instance: 'launch-2' });
    expect(t.loop.state).toBe('paused');
    expect(t.loop.reason).toBe('app-restarted');
    // Another status in Manual doesn't end it, and Resume does nothing until Full auto.
    t.setConfig({ ...CONFIG, mode: 'manual', instance: 'launch-2' });
    t.loop.resume();
    expect(t.loop.reason).toBe('app-restarted');
    t.setConfig({ ...CONFIG, instance: 'launch-2' });
    t.loop.resume();
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('with catching up off, pauses after sleep only when it was in the middle of a step', async () => {
    const t = setup({ catchUpAfterSleep: false });
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    t.loop.onWake();
    expect(t.loop.state).toBe('waiting-reply');

    let finish: (outcome: RunOutcome) => void = () => {};
    const slow = reply({
      runs: [{ command: 'pnpm test', outcome: () => new Promise((r) => (finish = r)) }]
    });
    t.loop.onReply(slow.actions);
    await settle();
    expect(t.loop.state).toBe('acting');
    t.loop.onWake();
    expect(t.loop.state).toBe('paused');
    expect(t.loop.reason).toBe('slept');
    expect(t.cancels).toBeGreaterThan(0);
    // The run that was cut short drops its result; Resume runs it again.
    finish({ ok: true, result: result(0) });
    await settle();
    expect(t.page.sent).toHaveLength(1);
    t.loop.resume();
    await settle();
    finish({ ok: true, result: result(0) });
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.page.sent).toHaveLength(2);
  });

  describe('format reminders', () => {
    it('asks the chat to redo a reply that missed the format, instead of acting on it', async () => {
      const t = setup();
      const broken = reply({ formatIssues: true });
      t.loop.onReply(broken.actions);
      await settle();
      expect(t.page.sent).toEqual([FORMAT_REMINDER]);
      expect(broken.log).toEqual(['reminded']);
      expect(t.loop.state).toBe('waiting-reply');
      expect(t.loop.step).toBe(1);
      expect(t.events()).toContain('sent: Sent message 1 of 10: a format reminder (1 of 2).');
    });

    it('applies and runs nothing from that reply, but sends the files it asked for', async () => {
      const t = setup();
      const broken = reply({
        formatIssues: true,
        edits: { applied: ['a.ts'] },
        reads: ['b.ts'],
        runs: [{ command: 'pnpm test' }]
      });
      t.loop.onReply(broken.actions);
      await settle();
      // Read, then the reminder with the file: its READ card is answered either way.
      expect(broken.log).toEqual(['read', 'reminded', 'reads-sent']);
      expect(t.page.sent).toHaveLength(1);
      expect(t.page.sent[0]!.startsWith(FORMAT_REMINDER)).toBe(true);
      expect(t.page.sent[0]).toContain('@@CONTEXT b.ts@@');
      expect(t.page.sent[0]).not.toContain('Applied');
    });

    it('carries on normally once the chat gets the format right', async () => {
      const t = setup();
      t.loop.onReply(reply({ formatIssues: true }).actions);
      await settle();
      t.advance(LOOP_MIN_SEND_GAP_MS);
      const fixed = reply({ runs: [{ command: 'pnpm test' }] });
      t.loop.onReply(fixed.actions);
      await settle();
      expect(fixed.log).toEqual(['apply:loop-1', 'run:pnpm test', 'reads-sent']);
      expect(t.page.sent).toHaveLength(2);
      expect(t.loop.step).toBe(2);
    });

    it('sends at most one reminder per step, even after a failed send and Resume', async () => {
      const t = setup();
      t.page.sendWorks = false;
      const broken = reply({ formatIssues: true });
      t.loop.onReply(broken.actions);
      await settle();
      expect(t.loop.state).toBe('paused');
      expect(t.loop.reason).toBe('send-failed');
      t.page.sendWorks = true;
      t.loop.resume();
      await settle();
      // The same reminder, still in the composer, went out once.
      expect(t.page.sent).toEqual([FORMAT_REMINDER]);
      expect(broken.log).toEqual(['reminded']);
      expect(t.loop.step).toBe(1);
      expect(t.events().filter((e) => e.includes('format reminder'))).toHaveLength(1);
    });

    it(`sends at most ${MAX_FORMAT_REMINDERS} per run, then pauses with format-issues`, async () => {
      const t = setup();
      for (let i = 0; i < MAX_FORMAT_REMINDERS; i += 1) {
        t.loop.onReply(reply({ formatIssues: true }).actions);
        await settle();
        t.advance(LOOP_MIN_SEND_GAP_MS);
      }
      expect(t.page.sent).toEqual([FORMAT_REMINDER, FORMAT_REMINDER]);
      const third = reply({ formatIssues: true });
      t.loop.onReply(third.actions);
      await settle();
      expect(t.page.sent).toHaveLength(2);
      expect(third.log).toEqual([]);
      expect(t.loop.state).toBe('paused');
      expect(t.loop.reason).toBe('format-issues');
      expect(t.reports.at(-1)).toMatchObject({ state: 'paused', reason: 'format-issues' });
      expect(t.loop.step).toBe(2);
    });

    it('acts on what Bridge could read when Resumed after format-issues', async () => {
      const t = setup();
      for (let i = 0; i < MAX_FORMAT_REMINDERS; i += 1) {
        t.loop.onReply(reply({ formatIssues: true }).actions);
        await settle();
        t.advance(LOOP_MIN_SEND_GAP_MS);
      }
      const third = reply({ formatIssues: true, runs: [{ command: 'pnpm test' }] });
      t.loop.onReply(third.actions);
      await settle();
      expect(t.loop.reason).toBe('format-issues');
      t.loop.resume();
      await settle();
      expect(third.log).toEqual(['apply:loop-1', 'run:pnpm test', 'reads-sent']);
      expect(t.page.sent).toHaveLength(3);
      expect(t.page.sent[2]).not.toBe(FORMAT_REMINDER);
    });

    it('waits for the next reply when Resumed after format-issues with nothing to act on', async () => {
      const t = setup();
      for (let i = 0; i <= MAX_FORMAT_REMINDERS; i += 1) {
        t.loop.onReply(reply({ formatIssues: true }).actions);
        await settle();
        t.advance(LOOP_MIN_SEND_GAP_MS);
      }
      expect(t.loop.reason).toBe('format-issues');
      t.loop.resume();
      expect(t.loop.state).toBe('waiting-reply');
      expect(t.page.sent).toHaveLength(2);
    });

    it('starts a new run with a fresh count', async () => {
      const t = setup();
      for (let i = 0; i < MAX_FORMAT_REMINDERS; i += 1) {
        t.loop.onReply(reply({ formatIssues: true }).actions);
        await settle();
        t.advance(LOOP_MIN_SEND_GAP_MS);
      }
      t.loop.onReply(reply().actions); // no actions: the run ends
      expect(t.loop.state).toBe('idle');
      t.loop.onReply(reply({ formatIssues: true }).actions);
      await settle();
      expect(t.page.sent).toHaveLength(3);
      expect(t.loop.state).toBe('waiting-reply');
    });

    it('lets a DONE reply end the run, issues or not', async () => {
      const t = setup();
      const done = reply({ formatIssues: true, done: true, edits: { applied: ['a.ts'] } });
      t.loop.onReply(done.actions);
      await settle();
      expect(t.page.sent).toEqual([]);
      expect(done.log).toEqual(['apply:-']);
      expect(t.loop.state).toBe('idle');
    });

    it('counts reminders against the step limit', async () => {
      const t = setup({ stepLimit: 1 });
      t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
      await settle();
      t.advance(LOOP_MIN_SEND_GAP_MS);
      t.loop.onReply(reply({ formatIssues: true }).actions);
      await settle();
      expect(t.loop.reason).toBe('step-limit');
      expect(t.page.sent).toHaveLength(1);
    });
  });
});

describe('FullAutoLoop after sleep', () => {
  /** A run that has sent its first follow-up and waits for the reply. */
  async function waiting(config: Partial<BridgeConfig> = {}) {
    const t = setup(config);
    t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
    await settle();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.page.sent).toHaveLength(1);
    return t;
  }

  it('waits for a reply still streaming on wake, without pausing, then acts on it', async () => {
    const t = await waiting();
    t.page.status = 'streaming';
    t.loop.onWake();
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.loop.note).toBe('after-sleep');
    expect(t.reports.at(-1)).toMatchObject({ state: 'waiting-reply', note: 'after-sleep' });
    // The reply keeps growing: no stall, no pause.
    for (let i = 0; i < 5; i += 1) {
      t.advance(30_000);
      t.page.length += 50;
      t.loop.tick();
    }
    expect(t.loop.state).toBe('waiting-reply');

    t.page.status = 'complete';
    t.loop.onReply(reply({ edits: { applied: ['src/a.ts'] } }).actions);
    await settle();
    expect(t.events()).toContain('resumed: Caught up after sleep.');
    expect(t.page.sent).toHaveLength(2);
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.loop.note).toBeUndefined();
  });

  it('acts on a reply that finished while asleep, and the loop goes on', async () => {
    const t = await waiting();
    t.loop.onWake();
    t.loop.onReply(reply({ reads: ['src/b.ts'] }).actions);
    await settle();
    expect(t.events()).toContain('resumed: Caught up after sleep.');
    expect(t.page.sent).toHaveLength(2);
    expect(t.page.sent[1]).toContain('@@CONTEXT src/b.ts@@');
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('keeps a reply that finished while the app was out of reach, and acts once it’s back', async () => {
    const t = await waiting();
    t.loop.onWake();
    // The socket died in the sleep: no pause while the reply may still be coming.
    t.setConfig(null);
    expect(t.loop.state).toBe('waiting-reply');
    t.loop.onReply(reply({ edits: { applied: ['src/a.ts'] } }).actions);
    expect(t.loop.reason).toBe('disconnected');
    expect(t.page.sent).toHaveLength(1);
    t.setConfig(CONFIG);
    await settle();
    expect(t.page.sent).toHaveLength(2);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('picks a half-done step up again when the connection comes back after waking', async () => {
    const t = setup();
    t.loop.onReply(
      reply({
        runs: [
          { command: 'pnpm test', outcome: { ok: false, disconnected: true, message: 'gone' } }
        ]
      }).actions
    );
    t.loop.onWake();
    await settle();
    expect(t.loop.reason).toBe('disconnected');
    t.setConfig(CONFIG);
    await settle();
    // Back without a Resume: it carried on with the step.
    expect(t.events()).toContain('resumed: Resumed.');

    // Long after waking, a lost connection pauses for Resume as before.
    const u = await waiting();
    u.loop.onWake();
    u.advance(WAKE_WINDOW_MS + 1);
    u.setConfig(null);
    expect(u.loop.reason).toBe('disconnected');
    u.setConfig(CONFIG);
    expect(u.loop.state).toBe('paused');
  });

  it(`stops a reply stuck for ${STALL_MS / 1000}s once on its own, then pauses if it sticks again`, async () => {
    const t = await waiting();
    t.page.status = 'streaming';
    t.loop.onWake();
    t.advance(STALL_MS - 1_000);
    t.loop.tick();
    expect(t.page.stops).toBe(0);
    t.advance(1_000);
    t.loop.tick();
    expect(t.page.stops).toBe(1);
    expect(t.loop.state).toBe('waiting-reply');
    expect(t.events()).toContain('paused: The chat seems stuck after sleep.');

    // What came through is acted on, and the chat is asked to continue.
    t.loop.onReply(
      reply({
        edits: { applied: ['src/one.ts'] },
        interruption: { marker: '@@FILE src/one.ts@@', cutOff: 'src/two.ts' }
      }).actions
    );
    await settle();
    expect(t.page.sent).toHaveLength(2);
    expect(t.page.sent[1]).toContain('Applied: src/one.ts.');
    expect(t.page.sent[1]).toContain(
      'Your last reply was cut off after @@FILE src/one.ts@@. Continue from there'
    );

    // The continuation sticks too: this time Full auto pauses and offers Stop & continue.
    t.page.status = 'streaming';
    t.page.length = 10;
    t.loop.tick();
    t.advance(STALL_MS);
    t.loop.tick();
    expect(t.loop.reason).toBe('stalled');
    expect(t.page.stops).toBe(1);
    t.loop.stopAndContinue();
    expect(t.page.stops).toBe(2);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('pauses on a stuck reply the page won’t let it stop', async () => {
    const t = await waiting();
    t.page.status = 'streaming';
    t.page.canStop = false;
    t.loop.onWake();
    t.advance(STALL_MS);
    t.loop.tick();
    expect(t.loop.reason).toBe('stalled');
  });

  it('acts on only the whole blocks of a cut-off reply and asks for the rest', async () => {
    const t = await waiting();
    const cut = reply({
      edits: { applied: ['src/one.ts'] },
      interruption: { marker: '@@FILE src/one.ts@@', cutOff: 'src/two.ts' }
    });
    t.loop.onReply(cut.actions);
    await settle();
    expect(cut.log).toContain('apply:loop-1');
    const sent = t.page.sent[1]!;
    expect(sent).toContain('Applied: src/one.ts.');
    expect(sent).not.toContain('src/two.ts (');
    expect(sent).toContain('Resend src/two.ts in full if it was cut off.');
    expect(sent).toContain("Don't repeat files that were already complete.");
    expect(t.events()).toContain(
      'resumed: The reply was cut off after @@FILE src/one.ts@@. Asking the chat to continue.'
    );
  });

  it('sends the continuation with the cut-off reply’s error banner still on the page', async () => {
    const t = await waiting();
    t.page.status = 'interrupted';
    t.page.banner = 'Network error';
    t.loop.onReply(reply({ interruption: { marker: '@@RUN pnpm test@@' } }).actions);
    await settle();
    expect(t.page.sent).toHaveLength(2);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('prefers the page’s own Continue generating, which keeps the same reply', async () => {
    const t = await waiting();
    t.page.canContinue = true;
    t.loop.onReply(
      reply({ interruption: { marker: '@@RUN pnpm test@@', pageContinue: true } }).actions
    );
    await settle();
    expect(t.page.continues).toBe(1);
    expect(t.page.sent).toHaveLength(1);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('sends the continuation at most once per interruption, then pauses', async () => {
    const t = await waiting();
    const cut = () =>
      reply({ interruption: { marker: '@@READ src/a.ts@@', cutOff: null } }).actions;
    t.loop.onReply(cut());
    await settle();
    expect(t.page.sent).toHaveLength(2);
    // The continuation is cut off as well: no second automatic one.
    t.loop.onReply(cut());
    await settle();
    expect(t.page.sent).toHaveLength(2);
    expect(t.loop.reason).toBe('interrupted');
    expect(t.reports.at(-1)).toMatchObject({
      reason: 'interrupted',
      detail: '@@READ src/a.ts@@',
      pageContinue: false,
      event: { text: 'The chat’s reply was interrupted after @@READ src/a.ts@@.' }
    });
    // Resume sends it.
    t.loop.resume();
    await settle();
    expect(t.page.sent).toHaveLength(3);
    expect(t.page.sent[2]).toContain('Your last reply was cut off after @@READ src/a.ts@@.');
    // A whole reply resets the count.
    t.loop.onReply(reply({ reads: ['src/c.ts'] }).actions);
    await settle();
    t.loop.onReply(cut());
    await settle();
    expect(t.page.sent).toHaveLength(5);
  });

  it('offers Continue generating from the pause when the page has it', async () => {
    const t = await waiting();
    t.page.online = false;
    t.page.canContinue = true;
    t.loop.onReply(reply({ interruption: { marker: null, pageContinue: true } }).actions);
    await settle();
    // Offline: nothing is sent on its own.
    expect(t.loop.reason).toBe('interrupted');
    expect(t.reports.at(-1)).toMatchObject({ pageContinue: true });
    t.page.online = true;
    t.loop.continueReply();
    expect(t.page.continues).toBe(1);
    expect(t.loop.state).toBe('waiting-reply');
  });

  it('waits for a cut-off reply to arrive before pausing on its error banner', async () => {
    const t = await waiting();
    t.page.status = 'interrupted';
    t.page.banner = 'Network error';
    t.loop.tick();
    expect(t.loop.state).toBe('waiting-reply');
    t.advance(INTERRUPT_GRACE_MS);
    t.loop.tick();
    expect(t.loop.reason).toBe('page-error');
  });

  it('asks about a command sleep interrupted: Re-run runs it again', async () => {
    const t = setup();
    let finish: (outcome: RunOutcome) => void = () => {};
    const slow = reply({
      runs: [{ command: 'pnpm test', outcome: () => new Promise((r) => (finish = r)) }]
    });
    t.loop.onReply(slow.actions);
    await settle();
    t.loop.onWake();
    expect(t.loop.reason).toBe('command-interrupted');
    expect(t.reports.at(-1)).toMatchObject({ detail: 'pnpm test' });
    expect(t.cancels).toBe(1);
    // The cancelled run's result is dropped.
    finish({ ok: true, result: result(0) });
    await settle();
    expect(t.page.sent).toHaveLength(0);
    t.loop.resume();
    await settle();
    expect(slow.log.filter((l) => l === 'run:pnpm test')).toHaveLength(2);
    finish({ ok: true, result: result(0, 'second') });
    await settle();
    expect(t.page.sent).toHaveLength(1);
    expect(t.page.sent[0]).toContain('second');
  });

  it('asks about a command sleep interrupted: Skip tells the chat and carries on', async () => {
    const t = setup();
    const slow = reply({
      runs: [
        { command: 'pnpm test', outcome: () => new Promise<RunOutcome>(() => {}) },
        { command: 'pnpm lint' }
      ]
    });
    t.loop.onReply(slow.actions);
    await settle();
    t.loop.onWake();
    t.loop.skipRun();
    await settle();
    expect(slow.log).toContain('run:pnpm lint');
    expect(t.page.sent).toHaveLength(1);
    expect(t.page.sent[0]).toContain('The command `pnpm test` was interrupted and skipped.');
  });

  it('stays paused when the conversation changed during sleep', async () => {
    const t = await waiting();
    t.loop.onWake();
    t.page.conversation = 'conv-2';
    t.loop.onNavigate('conv-2');
    expect(t.loop.reason).toBe('navigated');
    t.loop.resume();
    expect(t.loop.state).toBe('paused');
    t.loop.tick();
    expect(t.loop.reason).toBe('navigated');
  });

  it('with catching up off, keeps the old pause-and-Resume, and never stops a reply', async () => {
    const t = await waiting({ catchUpAfterSleep: false });
    t.page.status = 'streaming';
    t.loop.onWake();
    expect(t.loop.note).toBeUndefined();
    t.advance(STALL_MS * 2);
    t.loop.tick();
    expect(t.page.stops).toBe(0);
    t.setConfig(null);
    expect(t.loop.reason).toBe('disconnected');
    t.setConfig({ ...CONFIG, catchUpAfterSleep: false });
    expect(t.loop.state).toBe('paused');
  });
});

describe('FullAutoLoop 1.3.0', () => {
  /** Sends `n` replies in a row, each answered; returns the loop. */
  async function steps(t: ReturnType<typeof setup>, make: (i: number) => ReplyActions, n: number) {
    for (let i = 0; i < n; i += 1) {
      t.loop.onReply(make(i));
      await settle();
      t.advance(LOOP_MIN_SEND_GAP_MS);
    }
  }

  describe('requested files always go out', () => {
    it('reads them before a held edit pauses the step, and sends them on Resume', async () => {
      const t = setup();
      const r = reply({
        edits: { held: [{ path: 'package.json', hold: 'gated' }] },
        reads: ['src/a.ts']
      });
      t.loop.onReply(r.actions);
      await settle();
      expect(t.loop.reason).toBe('gated');
      // Read already, before the pause.
      expect(r.log).toEqual(['apply:loop-1', 'read']);
      t.loop.resume();
      await settle();
      expect(t.page.sent[0]).toContain('@@CONTEXT src/a.ts@@');
      expect(t.page.sent[0]).toContain('Not applied: package.json (gated)');
      expect(r.log.at(-1)).toBe('reads-sent');
    });

    it('sends refused files as refused without pausing', async () => {
      const t = setup();
      const r = reply({ reads: ['.env'] });
      r.actions.readFiles = async () => ({
        files: [],
        refused: [{ path: '.env', reason: 'protected file' }],
        disconnected: false
      });
      t.loop.onReply(r.actions);
      await settle();
      expect(t.page.sent[0]).toContain('Bridge could not send: .env (protected file).');
      expect(t.loop.state).toBe('waiting-reply');
    });

    it('attaches the images the chat asked for, then waits longer for the send button', async () => {
      const t = setup();
      t.page.buttonLate = 25; // uploading: the button stays off for a while
      const r = reply({ reads: ['shot.png', 'src/a.ts'], images: ['shot.png'] });
      t.loop.onReply(r.actions);
      await settle();
      expect(t.page.attached).toEqual([['shot.png']]);
      expect(t.page.sent[0]).toContain('Attached image: shot.png.');
      expect(t.page.sent[0]).toContain('@@CONTEXT src/a.ts@@');
      expect(t.loop.state).toBe('waiting-reply');
      expect(ATTACH_SEND_WAIT_MS).toBeGreaterThan(25 * 250);
    });

    it('pauses with send-failed when the images can’t be attached', async () => {
      const t = setup();
      t.page.attachWorks = false;
      t.loop.onReply(reply({ reads: ['shot.png'], images: ['shot.png'] }).actions);
      await settle();
      expect(t.loop.reason).toBe('send-failed');
      expect(t.page.sent).toEqual([]);
    });
  });

  describe('Unlimited', () => {
    it('never pauses for a step limit', async () => {
      const t = setup({ stepLimit: null });
      await steps(t, () => reply({ edits: { applied: ['a.ts'] } }).actions, 40);
      expect(t.page.sent).toHaveLength(40);
      expect(t.loop.state).toBe('waiting-reply');
      expect(t.reports.at(-1)).toMatchObject({ step: 40, limit: null });
      expect(t.events()).toContain('sent: Sent message 40.');
    });

    it('a limit still pauses, and Continue adds no limit once it’s Unlimited', async () => {
      const t = setup({ stepLimit: 2 });
      await steps(t, () => reply({ edits: { applied: ['a.ts'] } }).actions, 3);
      expect(t.loop.reason).toBe('step-limit');
      t.setConfig({ ...CONFIG, stepLimit: null });
      t.loop.continueFor();
      await settle();
      expect(t.loop.limit).toBeNull();
      expect(t.page.sent).toHaveLength(3);
    });
  });

  describe('loop guard', () => {
    const failing = (output: string) => ({
      command: 'pnpm test',
      outcome: { ok: true as const, result: { ...result(1), output } }
    });

    it(`pauses when the same command fails the same way ${LOOP_GUARD_REPEATS} times in a row`, async () => {
      const t = setup({ stepLimit: null });
      await steps(
        t,
        (i) => reply({ runs: [failing(`FAIL x.test.ts\nDuration ${i}.2s`)] }).actions,
        3
      );
      expect(t.loop.reason).toBe('stuck');
      expect(t.reports.at(-1)).toMatchObject({ reason: 'stuck', detail: 'pnpm test' });
      expect(t.events()).toContain('paused: Looks stuck: the same failure repeated (pnpm test).');
      expect(t.page.sent).toHaveLength(2);
    });

    it('starts counting again after a different failure or a pass', async () => {
      const t = setup({ stepLimit: null });
      const outputs = ['FAIL a', 'FAIL a', 'FAIL b', 'FAIL b', 'ok', 'FAIL b', 'FAIL b'];
      await steps(
        t,
        (i) =>
          reply({
            runs: [outputs[i] === 'ok' ? { command: 'pnpm test' } : failing(outputs[i]!)]
          }).actions,
        outputs.length
      );
      expect(t.loop.state).toBe('waiting-reply');
      expect(t.page.sent).toHaveLength(outputs.length);
    });

    it(`pauses when a file is written with the same content ${LOOP_GUARD_REPEATS} times`, async () => {
      const t = setup({ stepLimit: null });
      const same = [{ path: 'src/app.ts', hash: 'aaaa' }];
      await steps(
        t,
        () => reply({ edits: { applied: ['src/app.ts'] }, fingerprints: same }).actions,
        3
      );
      expect(t.loop.reason).toBe('stuck');
      expect(t.reports.at(-1)).toMatchObject({ detail: 'src/app.ts' });
      // Resume: the user looked, so it counts from zero again.
      t.loop.resume();
      await settle();
      expect(t.page.sent).toHaveLength(3);
      t.advance(LOOP_MIN_SEND_GAP_MS);
      t.loop.onReply(reply({ edits: { applied: ['src/app.ts'] }, fingerprints: same }).actions);
      await settle();
      expect(t.loop.state).toBe('waiting-reply');
    });

    it('lets different content to the same file through', async () => {
      const t = setup({ stepLimit: null });
      await steps(
        t,
        (i) =>
          reply({ edits: { applied: ['a.ts'] }, fingerprints: [{ path: 'a.ts', hash: `h${i}` }] })
            .actions,
        5
      );
      expect(t.loop.state).toBe('waiting-reply');
    });
  });

  describe('things that always wait for the user', () => {
    it('pauses for a download, and says it wasn’t downloaded if the user goes on without it', async () => {
      const t = setup({ autoApprove: { changes: true, gated: true, partial: true } });
      const downloads = { applied: [] as string[], pending: ['public/logo.svg'] };
      t.loop.onReply(reply({ downloads }).actions);
      await settle();
      expect(t.loop.reason).toBe('download');
      t.loop.resume();
      await settle();
      expect(t.page.sent[0]).toContain('Not applied: public/logo.svg (not downloaded).');
    });

    it('lists a download the user clicked as applied', async () => {
      const t = setup();
      const r = reply({ downloads: { applied: [], pending: ['logo.svg'] } });
      const downloads = { applied: [] as string[], pending: ['logo.svg'] };
      r.actions.downloads = () => downloads;
      t.loop.onReply(r.actions);
      await settle();
      downloads.pending = [];
      downloads.applied = ['logo.svg (downloaded)'];
      t.loop.resume();
      await settle();
      expect(t.page.sent[0]).toContain('Applied: logo.svg (downloaded).');
    });

    it('pauses once for a START that isn’t allowed, then tells the chat', async () => {
      const t = setup();
      t.loop.onReply(
        reply({
          processes: [{ kind: 'start', command: 'npm run dev', refusal: 'not on the allowlist' }]
        }).actions
      );
      await settle();
      expect(t.loop.reason).toBe('not-allowed');
      t.loop.resume();
      await settle();
      expect(t.page.sent[0]).toContain("Bridge didn't start `npm run dev`: not on the allowlist");
    });
  });

  describe('background processes', () => {
    it('stops and starts in order, before commands, and says where it runs', async () => {
      const t = setup();
      const r = reply({
        processes: [
          { kind: 'stop', command: 'npm run api' },
          { kind: 'start', command: 'npm run dev' }
        ],
        runs: [{ command: 'pnpm test' }]
      });
      t.loop.onReply(r.actions);
      await settle();
      expect(r.log).toEqual([
        'apply:loop-1',
        'stop:npm run api',
        'start:npm run dev',
        'run:pnpm test',
        'reads-sent'
      ]);
      expect(t.page.sent[0]).toContain('Stopped `npm run api`.');
      expect(t.page.sent[0]).toContain(
        'Started `npm run dev` in the background, running at http://localhost:5173/.'
      );
    });

    it('starts the dev server a @@DONE@@ reply asks for, then ends without sending', async () => {
      const t = setup();
      t.loop.onReply(reply({ runs: [{ command: 'pnpm test' }] }).actions);
      await settle();
      const done = reply({
        edits: { applied: ['src/a.ts'] },
        processes: [
          { kind: 'start', command: 'npm run dev' },
          { kind: 'start', command: 'rm -rf /', refusal: 'not on the allowlist' }
        ],
        done: true
      });
      t.loop.onReply(done.actions);
      await settle();
      expect(done.log).toEqual(['apply:loop-1', 'start:npm run dev']);
      expect(t.loop.state).toBe('idle');
      expect(t.page.sent).toHaveLength(1);
      expect(t.events()).toContain('ran: Started npm run dev at http://localhost:5173/.');
      expect(t.events().at(-1)).toBe('done: The chat said it’s done.');
    });

    it('starts it too when the first reply in Full auto is already @@DONE@@', async () => {
      const t = setup();
      const done = reply({ processes: [{ kind: 'start', command: 'npm run dev' }], done: true });
      t.loop.onReply(done.actions);
      await settle();
      expect(done.log).toEqual(['apply:-', 'start:npm run dev']);
      expect(t.loop.state).toBe('idle');
      expect(t.page.sent).toHaveLength(0);
    });

    it('pauses when the app goes away mid-start', async () => {
      const t = setup();
      t.loop.onReply(
        reply({
          processes: [{ kind: 'start', command: 'npm run dev', outcome: { disconnected: true } }]
        }).actions
      );
      await settle();
      expect(t.loop.reason).toBe('disconnected');
    });

    it('sends the logs the chat asked for, and says when there are none', async () => {
      const t = setup();
      t.loop.onReply(
        reply({
          logs: [
            { command: 'npm run dev', lines: ['VITE ready', 'GET / 200'] },
            { command: 'npm run api', refused: 'not running' }
          ]
        }).actions
      );
      await settle();
      expect(t.page.sent[0]).toContain('Last 2 lines of `npm run dev`:');
      expect(t.page.sent[0]).toContain('GET / 200');
      expect(t.page.sent[0]).toContain("`npm run api` wasn't running.");
    });

    it('waits for the dev server to rebuild after edits, then sends the errors it printed', async () => {
      const t = setup();
      const r = reply({
        edits: { applied: ['src/App.tsx'] },
        errors: [
          { command: 'npm run dev', lines: ['[vite] Internal server error: Unexpected "}"'] }
        ]
      });
      t.loop.onReply(r.actions);
      await settle();
      expect(r.log).toEqual(['cursor', 'apply:loop-1', 'errors', 'reads-sent']);
      expect(t.sleeps).toContain(PROCESS_SETTLE_MS);
      expect(t.page.sent[0]).toContain('`npm run dev` printed errors after these edits:');
      expect(t.page.sent[0]).toContain('Unexpected "}"');
    });

    it('doesn’t look for errors when nothing was edited', async () => {
      const t = setup();
      const r = reply({
        runs: [{ command: 'pnpm test' }],
        errors: [{ command: 'x', lines: ['Error'] }]
      });
      t.loop.onReply(r.actions);
      await settle();
      expect(r.log).not.toContain('errors');
      expect(t.sleeps).not.toContain(PROCESS_SETTLE_MS);
    });
  });
});
