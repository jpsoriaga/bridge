import {
  buildLogsMessage,
  COMMAND_REJECTION_TEXT,
  commandRefusal,
  deniedArgument,
  formatArgv,
  formatUptime,
  isLocalUrl,
  LOGS_LINES,
  matchAllowlist,
  parseCommand,
  processTone,
  type BackgroundLogs,
  type BackgroundProcess,
  type BackgroundStarted,
  type BackgroundStopped,
  type BridgeConfig,
  type CommandParse,
  type FollowUpProcess,
  type ProcessLines
} from '@bridge/shared';
import type { RequestOutcome } from '../../../messages';
import { insertIntoComposer } from '../composer';
import { DIFF_RENDER_LIMIT, failureText, modeTag, type Ask } from './diff-card';
import {
  cardButton,
  copyButton,
  formatFixedBadge,
  h,
  icon,
  redactionNote,
  renderCard
} from './dom';
import { createHost } from './host';

/** How long Full auto waits for a started process to print its URL (or end) before going on. */
export const READY_WAIT_MS = 15_000;
/** Lines of an ended process that go to the chat, when it ended right after starting. */
const EXIT_LINES = 40;

export type ProcessKind = 'start' | 'stop' | 'logs';

/** The outcome of a START or STOP through this card, for Full auto's follow-up. */
export type ProcessOutcome = FollowUpProcess | { disconnected: true };
export type LogsOutcome = ProcessLines | { refused: string } | { disconnected: true };

const TITLES: Record<ProcessKind, string> = {
  start: 'Start in the background',
  stop: 'Stop',
  logs: 'Recent output of'
};

const unreachable = (code: string | undefined) =>
  code === undefined || code === 'not-connected' || code === 'timeout';

/**
 * One `@@START`, `@@STOP` or `@@LOGS`. It shows the process as the app reports it (running
 * at its URL, for how long, or how it ended). **Start** asks the app to start it (an
 * allowlisted background entry, checked there again), **Stop** stops it, **Send logs** puts
 * its last lines in the composer. Full auto does the same on its own.
 */
export class ProcessCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  readonly parsed: CommandParse;
  private config: BridgeConfig | null = null;
  private disabled = false;
  private busy = false;
  private error: string | null = null;
  private sent = false;
  /** Likely secrets Send logs replaced with `[redacted]`. */
  private redacted = 0;
  private logs: BackgroundLogs | null = null;
  private expanded = false;
  /** Waiting for a started process to say it's ready, or to end. */
  private waiters = new Set<() => void>();
  /** Started from this card (by a click or Full auto), so it isn't offered again. */
  private acted = false;
  private tick: ReturnType<typeof setInterval> | undefined;
  /** The marker was missing its closing `@@`. Set before the first `setConfig`. */
  formatFixed = false;

  constructor(
    readonly kind: ProcessKind,
    readonly command: string,
    private readonly ask: Ask
  ) {
    ({ host: this.host, root: this.root } = createHost('process-card'));
    this.parsed = parseCommand(command);
    this.render();
  }

  setConfig(config: BridgeConfig | null): void {
    this.config = config;
    for (const wake of this.waiters) wake();
    this.render();
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.render();
  }

  /** The process this card is about, as the app last reported it. */
  get process(): BackgroundProcess | null {
    if (!this.parsed.ok || !this.config) return null;
    const command = formatArgv(this.parsed.argv);
    return this.config.processes.find((p) => p.command === command) ?? null;
  }

  get running(): boolean {
    return this.process?.state === 'running';
  }

  /** Null if the app's allowlist allows starting it in the background; else why not. */
  refusal(): string | null {
    if (!this.parsed.ok) return COMMAND_REJECTION_TEXT[this.parsed.reason];
    if (!this.config) return 'the Bridge app isn’t connected';
    if (this.kind !== 'start') return null;
    switch (commandRefusal(this.parsed.argv, this.config.allowlist)) {
      case 'not-allowlisted':
        return 'it isn’t on the allowlist in the Bridge app';
      case 'denied-flag':
        return `Bridge never allows ${deniedArgument(this.parsed.argv) ?? 'that option'} here`;
      default:
        break;
    }
    const entry = matchAllowlist(this.parsed.argv, this.config.allowlist);
    return entry !== null && this.config.background.includes(entry)
      ? null
      : 'it isn’t marked as a background process in the Bridge app (run it with @@RUN)';
  }

  /** Waiting for a click: a START not started yet, for the side panel's request list. */
  get waiting(): boolean {
    return this.kind === 'start' && !this.acted && !this.running;
  }

  reveal(): void {
    this.host.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.root.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }

  /**
   * Starts it (restarting it if it's running). With `wait`, resolves once it printed its
   * URL, ended, or `READY_WAIT_MS` passed, with what the chat should hear.
   */
  async start(
    options: { trigger?: 'click' | 'auto'; loopId?: string } = {}
  ): Promise<ProcessOutcome> {
    const refusal = this.refusal();
    if (refusal !== null || !this.parsed.ok) {
      return { command: this.command, refused: refusal ?? 'it can’t start now' };
    }
    if (this.disabled) return { command: this.command, refused: 'the session ended' };
    this.busy = true;
    this.error = null;
    this.render();
    const outcome = await this.ask<RequestOutcome<BackgroundStarted>>({
      type: 'chat-bg-start',
      argv: this.parsed.argv,
      trigger: options.trigger ?? 'click',
      ...(options.loopId && { loopId: options.loopId })
    });
    this.busy = false;
    if (!outcome?.ok) {
      this.error = failureText(outcome?.error);
      this.render();
      return unreachable(outcome?.error.code)
        ? { disconnected: true }
        : { command: this.command, refused: this.error };
    }
    this.acted = true;
    this.startTicking();
    this.render();
    const { procId, restarted } = outcome.result;
    await this.until(() => {
      const proc = this.process;
      return proc?.procId === procId && (proc.url !== null || proc.state !== 'running');
    }, READY_WAIT_MS);
    const proc = this.process;
    if (proc?.procId === procId && proc.state !== 'running') {
      const logs = await this.fetchLogs(EXIT_LINES);
      const ended =
        proc.state === 'stopped'
          ? 'was stopped'
          : proc.exitCode !== null
            ? `exited with code ${proc.exitCode}`
            : `ended (${proc.signal ?? 'killed'})`;
      return { command: this.command, exited: ended, lines: logs?.lines ?? [] };
    }
    return { command: this.command, started: true, restarted, url: proc?.url ?? null };
  }

  /** Stops it, if it's running. */
  async stop(options: { trigger?: 'click' | 'auto' } = {}): Promise<ProcessOutcome> {
    if (!this.parsed.ok) {
      return { command: this.command, refused: COMMAND_REJECTION_TEXT[this.parsed.reason] };
    }
    this.busy = true;
    this.error = null;
    this.render();
    const outcome = await this.ask<RequestOutcome<BackgroundStopped>>({
      type: 'chat-bg-stop',
      argv: this.parsed.argv,
      trigger: options.trigger ?? 'click'
    });
    this.busy = false;
    this.acted = true;
    if (!outcome?.ok) {
      this.error = failureText(outcome?.error);
      this.render();
      return unreachable(outcome?.error.code)
        ? { disconnected: true }
        : { command: this.command, refused: this.error };
    }
    this.render();
    return { command: this.command, stopped: outcome.result.stopped };
  }

  /** Its last `LOGS_LINES` lines, already redacted by the app, for Full auto's follow-up. */
  async readLogs(): Promise<LogsOutcome> {
    if (!this.parsed.ok) return { refused: COMMAND_REJECTION_TEXT[this.parsed.reason] };
    const outcome = await this.ask<RequestOutcome<BackgroundLogs>>({
      type: 'chat-bg-logs',
      argv: this.parsed.argv,
      tail: LOGS_LINES
    });
    if (!outcome?.ok) {
      if (unreachable(outcome?.error.code)) return { disconnected: true };
      return { refused: `\`${this.command}\` isn’t running and has no log` };
    }
    this.logs = outcome.result;
    this.acted = true;
    this.render();
    return { command: this.command, lines: outcome.result.lines, url: this.process?.url ?? null };
  }

  private async fetchLogs(tail: number): Promise<BackgroundLogs | null> {
    if (!this.parsed.ok) return null;
    const outcome = await this.ask<RequestOutcome<BackgroundLogs>>({
      type: 'chat-bg-logs',
      argv: this.parsed.argv,
      tail
    });
    return outcome?.ok ? outcome.result : null;
  }

  /** Resolves when `done()` holds after a config change, or after `ms`. */
  private until(done: () => boolean, ms: number): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(check);
    });
  }

  /** The uptime on the card moves while it runs. */
  private startTicking(): void {
    if (this.tick) return;
    this.tick = setInterval(() => {
      if (!this.host.isConnected || !this.running) {
        clearInterval(this.tick);
        this.tick = undefined;
      }
      this.render();
    }, 1_000);
  }

  private async sendLogs(): Promise<void> {
    this.busy = true;
    this.render();
    const logs = await this.fetchLogs(LOGS_LINES);
    this.busy = false;
    if (!logs) {
      this.error = `${this.command} isn’t running, and Bridge has no output from it.`;
      this.render();
      return;
    }
    this.logs = logs;
    const { text, redacted } = buildLogsMessage({
      command: this.command,
      lines: logs.lines,
      url: this.process?.url ?? null
    });
    this.redacted = redacted;
    const result = insertIntoComposer(text);
    this.error = result.ok
      ? null
      : 'Bridge couldn’t insert the output. Click in the message box and try again.';
    this.sent = result.ok;
    this.render();
  }

  private badge(): { text: string; tone?: string } {
    const proc = this.process;
    if (this.kind === 'start' && this.refusal() !== null)
      return { text: 'not allowed', tone: 'danger' };
    if (!proc) return { text: this.kind === 'start' ? 'background' : 'not running' };
    if (proc.state === 'running') {
      return proc.url
        ? { text: 'running', tone: 'success' }
        : { text: 'starting', tone: 'warning' };
    }
    if (proc.state === 'stopped') return { text: 'stopped' };
    // A clean exit is neutral: only a failure or a kill is red.
    const tone = processTone(proc);
    return {
      text: proc.exitCode !== null ? `exit ${proc.exitCode}` : 'ended',
      ...(tone && { tone })
    };
  }

  private hint(): { text: string; tone?: string } {
    const proc = this.process;
    if (this.disabled) return { text: 'Session ended.' };
    if (!this.parsed.ok)
      return { text: COMMAND_REJECTION_TEXT[this.parsed.reason], tone: 'danger' };
    if (!this.config) return { text: 'Connect the Bridge app to run commands.' };
    if (this.kind === 'start' && this.refusal() !== null) {
      return { text: `Bridge can’t start it: ${this.refusal()}.` };
    }
    if (this.kind === 'logs') {
      return {
        text: this.sent
          ? `Added to the message box. Review it and press send.${this.redacted ? ` ${redactionNote(this.redacted)}` : ''}`
          : `Send logs puts its last ${LOGS_LINES} lines in the message box; you press send.`
      };
    }
    if (proc?.state === 'running') {
      return {
        text: `${proc.url ? 'Running' : 'Starting'} for ${formatUptime(Date.now() - proc.startedAt)}. It keeps running until it’s stopped or the session ends.`
      };
    }
    if (this.kind === 'stop') return { text: 'It isn’t running.' };
    return { text: 'Runs in your project, with no timeout, until it’s stopped.' };
  }

  private buttons(): HTMLElement[] {
    const off = this.disabled || this.busy || !this.config || !this.parsed.ok;
    const button = (
      label: string,
      focus: string,
      onClick: () => void,
      primary = false,
      danger = false
    ) => {
      const el = cardButton(
        danger ? 'danger' : primary ? 'primary' : 'secondary',
        {
          attrs: { 'data-focus': focus },
          onClick
        },
        label
      );
      el.disabled = off;
      return el;
    };
    const out: HTMLElement[] = [];
    if (this.kind === 'logs') {
      out.push(
        button(this.sent ? 'Send again' : 'Send logs', 'send', () => void this.sendLogs(), true)
      );
      return out;
    }
    if (this.running) out.push(button('Stop', 'stop', () => void this.stop(), false, true));
    if (this.kind === 'start' && this.refusal() === null) {
      // After it ended (on its own, or stopped), it's "Start again".
      const label = this.running ? 'Restart' : this.process ? 'Start again' : 'Start';
      out.push(button(label, 'start', () => void this.start(), !this.running));
    }
    return out;
  }

  private outputBody(): HTMLElement | null {
    if (!this.expanded || !this.logs) return null;
    const body = h('div', { class: 'body output' });
    for (const line of this.logs.lines.slice(-DIFF_RENDER_LIMIT))
      body.append(h('div', { class: 'row' }, line));
    if (this.logs.lines.length === 0) body.append(h('div', { class: 'row' }, '(no output yet)'));
    return body;
  }

  private render(): void {
    const badge = this.badge();
    const proc = this.process;
    const url = proc?.state === 'running' && proc.url && isLocalUrl(proc.url) ? proc.url : null;
    const toggle =
      this.kind === 'logs' && this.logs
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
    const { text, tone } = this.hint();
    const card = h(
      'div',
      {
        class: 'card',
        attrs: {
          'data-kind': 'process',
          'data-process': this.kind,
          role: 'group',
          'aria-label': `${TITLES[this.kind]} ${this.command}`
        }
      },
      h(
        'div',
        { class: 'header' },
        icon(this.kind === 'logs' ? 'terminal' : 'server'),
        h('span', { class: 'title' }, TITLES[this.kind]),
        h('span', { class: 'path command', attrs: { title: this.command } }, this.command),
        copyButton(this.command, 'Copy command'),
        h('span', { class: 'badge', attrs: { 'data-tone': badge.tone } }, badge.text),
        this.formatFixed ? formatFixedBadge() : null,
        h('span', { class: 'spacer' }),
        url
          ? h(
              'a',
              {
                class: 'link mono',
                attrs: {
                  href: url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  'data-focus': 'url'
                }
              },
              url
            )
          : null,
        toggle
      ),
      this.error
        ? h('p', { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } }, this.error)
        : null,
      this.outputBody(),
      h(
        'div',
        { class: 'footer' },
        h(
          'p',
          { class: 'hint', attrs: { 'data-tone': tone } },
          modeTag(this.config?.mode ?? null),
          text
        ),
        ...this.buttons()
      )
    );
    renderCard(this.root, card);
  }
}
