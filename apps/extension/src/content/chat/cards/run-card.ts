import {
  COMMAND_REJECTION_TEXT,
  formatRunResult,
  matchAllowlist,
  parseCommand,
  type BridgeConfig,
  type CommandParse,
  type Mode,
  type RunResult,
  type RunStarted
} from '@bridge/shared';
import type { RequestOutcome } from '../../../messages';
import { insertIntoComposer } from '../composer';
import { DIFF_RENDER_LIMIT, failureText, modeTag, type Ask } from './diff-card';
import { copyButton, formatCount, formatTime, h, icon, renderCard } from './dom';
import { createHost } from './host';

export type RunBadge =
  | 'allowlisted'
  | 'not allowed'
  | 'running'
  | 'exit 0'
  | `exit ${number}`
  | 'timed out'
  | 'cancelled'
  | 'failed';

/** What a run through this card came to, for the loop and the tests. */
export type RunCardOutcome =
  { ok: true; result: RunResult } | { ok: false; disconnected: boolean; message: string };

const BADGE_TONES: Partial<Record<string, string>> = {
  'not allowed': 'danger',
  running: 'warning',
  'exit 0': 'success',
  'timed out': 'danger',
  failed: 'danger'
};

/**
 * One `@@RUN` command. It says whether the app's allowlist lets it run; **Run** asks the
 * desktop to run it (which checks again), the output streams in, and **Send output** puts
 * it in the composer for the user to send. The card never changes the allowlist: a
 * command that isn't on it says to add it in the Bridge app.
 */
export class RunCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  readonly parsed: CommandParse;
  private config: BridgeConfig | null = null;
  private disabled = false;
  private runId: string | null = null;
  private output = '';
  result: RunResult | null = null;
  private error: string | null = null;
  private starting = false;
  private cancelling = false;
  private sent = false;
  private expanded = true;
  private showAll = false;
  private waiter: ((result: RunResult) => void) | null = null;
  /** Epoch ms when the last run ended, for the header. */
  private finishedAt: number | null = null;

  constructor(
    readonly command: string,
    private readonly ask: Ask,
    /** The desktop answered with a run id: route its output and exit here. */
    private readonly onRunId: (runId: string, card: RunCard) => void
  ) {
    ({ host: this.host, root: this.root } = createHost('run-card'));
    this.parsed = parseCommand(command);
    this.render();
  }

  setConfig(config: BridgeConfig | null): void {
    this.config = config;
    this.render();
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.render();
  }

  private get mode(): Mode | null {
    return this.config?.mode ?? null;
  }

  /** Null if the app's allowlist (as last mirrored) allows it; else why not. */
  refusal(): string | null {
    if (!this.parsed.ok) return COMMAND_REJECTION_TEXT[this.parsed.reason];
    if (!this.config) return 'the Bridge app isn’t connected';
    if (!matchAllowlist(this.parsed.argv, this.config.allowlist)) {
      return 'it isn’t on the allowlist in the Bridge app';
    }
    return null;
  }

  get running(): boolean {
    return this.starting || (this.runId !== null && this.result === null);
  }

  get badge(): RunBadge {
    if (this.running) return 'running';
    if (this.result) {
      switch (this.result.status) {
        case 'timed-out':
          return 'timed out';
        case 'cancelled':
          return 'cancelled';
        case 'failed':
          return 'failed';
        case 'exited':
          return this.result.exitCode === 0 ? 'exit 0' : `exit ${this.result.exitCode ?? 1}`;
      }
    }
    return this.parsed.ok && this.config && matchAllowlist(this.parsed.argv, this.config.allowlist)
      ? 'allowlisted'
      : 'not allowed';
  }

  /** Runs the command. Resolves when it exits, or at once if the desktop refuses it. */
  async run(
    options: { trigger?: 'click' | 'auto'; loopId?: string } = {}
  ): Promise<RunCardOutcome> {
    const refusal = this.refusal();
    if (this.running || this.disabled || refusal !== null || !this.parsed.ok) {
      return { ok: false, disconnected: false, message: refusal ?? 'it can’t run now' };
    }
    this.starting = true;
    this.error = null;
    this.result = null;
    this.output = '';
    this.sent = false;
    this.render();
    const outcome = await this.ask<RequestOutcome<RunStarted>>({
      type: 'chat-run',
      argv: this.parsed.argv,
      trigger: options.trigger ?? 'click',
      ...(options.loopId && { loopId: options.loopId })
    });
    this.starting = false;
    if (!outcome?.ok) {
      this.error = failureText(outcome?.error);
      this.render();
      const code = outcome?.error.code;
      return {
        ok: false,
        disconnected: !outcome || code === 'not-connected' || code === 'timeout',
        message: this.error
      };
    }
    this.runId = outcome.result.runId;
    const exited = new Promise<RunResult>((resolve) => (this.waiter = resolve));
    this.onRunId(outcome.result.runId, this);
    this.render();
    return { ok: true, result: await exited };
  }

  /** Live output from the desktop. */
  onOutput(chunk: string): void {
    this.output += chunk;
    this.render();
  }

  onExit(result: RunResult): void {
    this.result = result;
    this.finishedAt = Date.now();
    this.output = result.output;
    this.cancelling = false;
    this.render();
    this.waiter?.(result);
    this.waiter = null;
  }

  /** Waiting for a click: not run yet, not running. For the side panel's request list. */
  get waiting(): boolean {
    return !this.running && this.result === null;
  }

  /** Scrolls the card into view and focuses Run, for "Show" in the side panel. */
  reveal(): void {
    this.host.scrollIntoView({ block: 'center', behavior: 'smooth' });
    (
      this.root.querySelector<HTMLElement>('[data-focus="run"]:not(:disabled)') ??
      this.root.querySelector<HTMLElement>('button')
    )?.focus();
  }

  async cancel(): Promise<void> {
    if (!this.runId || this.result || this.cancelling) return;
    this.cancelling = true;
    this.render();
    await this.ask({ type: 'chat-run-cancel', runId: this.runId });
  }

  /** The text Send output inserts. */
  message(): string | null {
    return this.result ? formatRunResult(this.result) : null;
  }

  private sendOutput(): void {
    const text = this.message();
    if (!text) return;
    const result = insertIntoComposer(text);
    if (!result.ok) {
      this.error =
        result.error === 'no-composer'
          ? 'Bridge can’t find the message box on this page.'
          : 'Bridge couldn’t insert the output. Click in the message box and try again.';
    } else {
      this.sent = true;
      this.error = null;
    }
    this.render();
  }

  private outputBody(): HTMLElement | null {
    if (!this.expanded || (!this.output && !this.running)) return null;
    const lines = this.output.replace(/\n$/, '').split('\n');
    const shown = this.showAll ? lines : lines.slice(-DIFF_RENDER_LIMIT);
    const body = h('div', { class: 'body output' });
    if (shown.length < lines.length) {
      body.append(
        h(
          'button',
          {
            class: 'more',
            attrs: { type: 'button' },
            onClick: () => {
              this.showAll = true;
              this.render();
            }
          },
          `Show all ${formatCount(lines.length)} lines`
        )
      );
    }
    for (const line of this.output ? shown : ['Starting…']) {
      body.append(h('div', { class: 'row' }, line));
    }
    return body;
  }

  private hint(): { text: string; tone?: string } {
    if (this.disabled) return { text: 'Session ended.' };
    if (!this.parsed.ok)
      return { text: COMMAND_REJECTION_TEXT[this.parsed.reason], tone: 'danger' };
    if (!this.config) return { text: 'Connect the Bridge app to run commands.' };
    if (this.running) return { text: this.cancelling ? 'Stopping…' : 'Running in your project.' };
    if (this.result) {
      return this.sent
        ? { text: 'Added to the message box. Review it and press send.' }
        : { text: 'Send output puts the result in the message box; you press send.' };
    }
    if (this.badge === 'not allowed') return { text: 'Add it to the allowlist in the Bridge app.' };
    return { text: 'Runs in your project with your permissions.' };
  }

  private render(): void {
    const badge = this.badge;
    const toggle =
      this.output || this.running
        ? h(
            'button',
            {
              class: 'link',
              attrs: {
                type: 'button',
                'aria-expanded': String(this.expanded),
                'data-focus': 'toggle'
              },
              onClick: () => {
                this.expanded = !this.expanded;
                this.render();
              }
            },
            this.expanded ? 'Hide output' : 'Show output',
            icon('chevron')
          )
        : null;

    const buttons: HTMLElement[] = [];
    if (this.running) {
      const cancel = h(
        'button',
        {
          class: 'btn btn-danger',
          attrs: { type: 'button', 'data-focus': 'cancel' },
          onClick: () => void this.cancel()
        },
        this.cancelling ? 'Cancelling…' : 'Cancel'
      );
      cancel.disabled = this.cancelling || this.runId === null;
      buttons.push(cancel);
    } else {
      if (this.result) {
        const send = h(
          'button',
          {
            class: 'btn btn-primary',
            attrs: { type: 'button', 'data-focus': 'send' },
            onClick: () => this.sendOutput()
          },
          this.sent ? 'Send again' : 'Send output'
        );
        send.disabled = this.disabled;
        buttons.push(send);
      }
      if (badge !== 'not allowed' || this.result) {
        const run = h(
          'button',
          {
            class: this.result ? 'btn' : 'btn btn-primary',
            attrs: { type: 'button', 'data-focus': 'run' },
            onClick: () => void this.run()
          },
          this.result ? 'Run again' : 'Run'
        );
        run.disabled = this.disabled || this.refusal() !== null;
        buttons.push(run);
      }
    }

    const { text, tone } = this.hint();
    const card = h(
      'div',
      {
        class: 'card',
        attrs: {
          'data-kind': 'run',
          'data-state': this.running ? 'running' : 'idle',
          role: 'group',
          'aria-label': `Command ${this.command}`
        }
      },
      h(
        'div',
        { class: 'header' },
        h('span', { class: 'prompt', attrs: { 'aria-hidden': 'true' } }, '$'),
        h('span', { class: 'path command', attrs: { title: this.command } }, this.command),
        copyButton(this.command, 'Copy command'),
        h(
          'span',
          {
            class: 'badge',
            attrs: {
              'data-tone': BADGE_TONES[badge] ?? (badge.startsWith('exit ') ? 'danger' : undefined)
            }
          },
          badge
        ),
        this.result
          ? h('span', { class: 'meta' }, `${(this.result.durationMs / 1000).toFixed(1)}s`)
          : null,
        this.finishedAt !== null ? h('span', { class: 'time' }, formatTime(this.finishedAt)) : null,
        h('span', { class: 'spacer' }),
        toggle
      ),
      this.error
        ? h('p', { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } }, this.error)
        : null,
      this.outputBody(),
      h(
        'div',
        { class: 'footer' },
        h('p', { class: 'hint', attrs: { 'data-tone': tone } }, modeTag(this.mode), text),
        ...buttons
      )
    );
    renderCard(this.root, card);
  }
}
