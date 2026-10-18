import {
  buildContextMessage,
  COMPOSER_WARN_CHARS,
  FILE_ERROR_LABELS,
  formatContextBlock,
  type ContextFile,
  type FileErrorCode,
  type ReadResult,
  type RefusedFile
} from '@bridge/shared';
import type { ReadCardRecord, RequestOutcome, SentFile } from '../../../messages';
import { insertIntoComposer } from '../composer';
import { failureText, type Ask } from './diff-card';
import { formatCount, h, icon, renderCard } from './dom';
import { createHost } from './host';

type Entry =
  | { path: string; status: 'loading' }
  | { path: string; status: 'ok'; content: string; hash: string }
  | { path: string; status: 'refused'; reason: string };

/**
 * The card under a reply that asked for files with `@@READ`. It reads each file to show
 * what would be sent and how big it is. **Send these files** puts them in the composer in
 * `@@CONTEXT` format; the user still presses send. Whether it was sent is saved by block
 * key, like a diff card's state, so a reload shows "Send again".
 */
export class ReadCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private entries: Entry[];
  private error: string | null = null;
  /** The files went into the composer at least once. */
  sent = false;
  private disabled = false;
  /** A read failed because the app wasn't there, not because the file was refused. */
  private unreachable = false;
  private reading: Promise<void> = Promise.resolve();
  private expanded = true;

  constructor(
    readonly key: string,
    readonly paths: readonly string[],
    private readonly ask: Ask,
    private readonly onSent: (files: SentFile[]) => void
  ) {
    ({ host: this.host, root: this.root } = createHost('read-card'));
    this.entries = paths.map((path) => ({ path, status: 'loading' }));
  }

  /** Restores a saved state, then reads each file to show what would be sent. */
  init(record?: ReadCardRecord): Promise<void> {
    this.sent = record?.state === 'sent';
    if (!record) void this.persist();
    this.reading = this.readAll();
    return this.reading;
  }

  /** Waits for every file to be read. */
  ready(): Promise<void> {
    return this.reading;
  }

  /** What Full auto sends: the files, the refusals, and whether the app was unreachable. */
  contents(): { files: ContextFile[]; refused: RefusedFile[]; disconnected: boolean } {
    return {
      files: this.entries.flatMap((e) =>
        e.status === 'ok' ? [{ path: e.path, content: e.content }] : []
      ),
      refused: this.entries.flatMap((e) =>
        e.status === 'refused' ? [{ path: e.path, reason: e.reason }] : []
      ),
      disconnected: this.unreachable
    };
  }

  /** Full auto sent these files in its follow-up. */
  markSent(): void {
    if (this.sent) return;
    this.sent = true;
    void this.persist();
    this.onSent(this.sentFiles());
    this.render();
  }

  /** The files that go out, with what each costs in the message and its hash. */
  private sentFiles(): SentFile[] {
    return this.entries.flatMap((e) =>
      e.status === 'ok'
        ? [{ path: e.path, chars: formatContextBlock(e.path, e.content).length, hash: e.hash }]
        : []
    );
  }

  /** Whether any file can be sent, for the side panel's request list. */
  get sendable(): boolean {
    return this.entries.some((e) => e.status !== 'refused');
  }

  /** Scrolls the card into view and puts focus on its button, for "Show" in the panel. */
  reveal(): void {
    this.host.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.root.querySelector<HTMLElement>('[data-focus="send"]')?.focus();
  }

  private async readAll(): Promise<void> {
    this.unreachable = false;
    this.render();
    for (const [i, path] of this.paths.entries()) {
      const outcome = await this.ask<RequestOutcome<ReadResult>>({ type: 'chat-read', path });
      if (outcome?.ok) {
        this.entries[i] = {
          path,
          status: 'ok',
          content: outcome.result.content,
          hash: outcome.result.hash
        };
      } else if (
        outcome &&
        outcome.error.code !== 'not-connected' &&
        outcome.error.code !== 'timeout' &&
        outcome.error.code !== 'bad-response' &&
        outcome.error.code !== 'no-session'
      ) {
        this.entries[i] = {
          path,
          status: 'refused',
          reason: FILE_ERROR_LABELS[outcome.error.code as FileErrorCode]
        };
      } else {
        this.error = failureText(outcome?.error);
        this.unreachable = true;
        this.entries[i] = { path, status: 'refused', reason: 'not read' };
      }
      this.render();
    }
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.render();
  }

  /** The text Send would insert. */
  message(): string {
    const files = this.entries.flatMap((e) =>
      e.status === 'ok' ? [{ path: e.path, content: e.content }] : []
    );
    const refused = this.entries.flatMap((e) =>
      e.status === 'refused' ? [{ path: e.path, reason: e.reason }] : []
    );
    return buildContextMessage(files, refused);
  }

  private send(): void {
    const text = this.message();
    const result = insertIntoComposer(text);
    if (!result.ok) {
      this.error =
        result.error === 'no-composer'
          ? 'Bridge can’t find the message box on this page.'
          : 'Bridge couldn’t insert the files. Click in the message box and try again.';
      this.render();
      return;
    }
    this.sent = true;
    this.error = null;
    void this.persist();
    this.onSent(this.sentFiles());
    this.render();
  }

  private persist(): Promise<unknown> {
    const record: ReadCardRecord = {
      card: 'read',
      state: this.sent ? 'sent' : 'pending',
      updatedAt: Date.now()
    };
    return this.ask({ type: 'card-set', key: this.key, record });
  }

  private render(): void {
    const loading = this.entries.some((e) => e.status === 'loading');
    const okCount = this.entries.filter((e) => e.status === 'ok').length;
    const chars = loading ? 0 : this.message().length;

    const rows = this.entries.map((entry) =>
      h(
        'li',
        { class: 'file', attrs: { 'data-blocked': String(entry.status === 'refused') } },
        icon('file'),
        h('span', { class: 'path', attrs: { title: entry.path } }, entry.path),
        entry.status === 'loading'
          ? h('span', { class: 'meta' }, 'Reading…')
          : entry.status === 'ok'
            ? h('span', { class: 'meta' }, `${formatCount(entry.content.length)} chars`)
            : h(
                'span',
                { class: 'badge', attrs: { 'data-tone': 'danger' } },
                `blocked · ${entry.reason}`
              )
      )
    );

    let hint = loading
      ? 'Reading files…'
      : okCount === 0
        ? 'None of these can be sent.'
        : `${formatCount(chars)} characters. Bridge puts them in the message box; you press send.`;
    let tone: string | undefined;
    if (!loading && chars > COMPOSER_WARN_CHARS) {
      hint = `${formatCount(chars)} characters. The chat may turn this into an attachment or cut it off.`;
      tone = 'warning';
    }
    if (this.sent) hint = 'Added to the message box. Review it and press send.';
    if (this.disabled) hint = 'Session ended.';

    const button = h(
      'button',
      {
        class: this.sent ? 'btn btn-lg' : 'btn btn-primary btn-lg',
        attrs: { type: 'button', 'data-focus': 'send' },
        onClick: () => this.send()
      },
      this.sent ? 'Send again' : 'Send these files'
    );
    button.disabled = this.disabled || loading || okCount === 0;
    const title = `The chat asked for ${this.paths.length} ${this.paths.length === 1 ? 'file' : 'files'}`;
    const toggle = h(
      'button',
      {
        class: 'link',
        attrs: { type: 'button', 'aria-expanded': String(this.expanded), 'data-focus': 'toggle' },
        onClick: () => {
          this.expanded = !this.expanded;
          this.render();
        }
      },
      this.expanded ? 'Hide files' : 'Show files',
      icon('chevron')
    );

    const card = h(
      'div',
      { class: 'card', attrs: { 'data-kind': 'read', role: 'group', 'aria-label': title } },
      h(
        'div',
        { class: 'header' },
        icon('file'),
        h('span', { class: 'title' }, title),
        this.sent ? h('span', { class: 'badge', attrs: { 'data-tone': 'success' } }, 'sent') : null,
        h('span', { class: 'spacer' }),
        toggle
      ),
      this.expanded ? h('ul', { class: 'files' }, ...rows) : null,
      this.error
        ? h('p', { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } }, this.error)
        : null,
      h(
        'div',
        { class: 'footer' },
        h('p', { class: 'hint', attrs: { 'data-tone': tone } }, hint),
        button
      )
    );
    renderCard(this.root, card);
  }
}
