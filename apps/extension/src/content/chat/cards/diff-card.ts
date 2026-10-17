import {
  diffFile,
  FILE_ERROR_LABELS,
  FILE_ERROR_MESSAGES,
  type FileDiff,
  type FileErrorCode,
  type ParsedEdit,
  type ReadResult,
  type UndoResult,
  type WriteResult
} from '@bridge/shared';
import type { CardRecord, CardState, RequestOutcome, WorkerRequest } from '../../../messages';
import { formatCount, h, icon } from './dom';
import { createHost } from './host';

/** Diff rows rendered before "Show all". */
export const DIFF_RENDER_LIMIT = 400;

export type Ask = <R>(request: WorkerRequest) => Promise<R | undefined>;

/** The file can't be touched at all: the sandbox refused the path, or it isn't text. */
const BLOCKING: ReadonlySet<string> = new Set<FileErrorCode>([
  'invalid-path',
  'absolute-path',
  'traversal',
  'denied',
  'outside-root',
  'not-a-file',
  'binary',
  'too-large'
]);

type Failure = Exclude<RequestOutcome<unknown>, { ok: true }>['error'];

export function failureText(error: Failure | undefined): string {
  if (!error) return 'The extension refused this request. Reload the page and try again.';
  switch (error.code) {
    case 'not-connected':
    case 'timeout':
      return 'The Bridge app isn’t connected. Open it, then try again.';
    case 'bad-response':
      return 'The Bridge app sent an unexpected reply.';
    case 'no-session':
      return 'This chat has no Bridge session. Start one from the side panel.';
    default:
      return FILE_ERROR_MESSAGES[error.code];
  }
}

export type Badge = 'new' | 'modified' | 'unchanged' | 'conflict' | 'blocked' | 'partial?';

/**
 * One `@@FILE` block's card. It reads the file when it appears, shows the diff, and
 * applies with the hash it read, so a file edited since gets `conflict` instead of being
 * overwritten. Everything from the chat is rendered as text.
 */
export class DiffCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  state: CardState = 'pending';
  /** What `read` found: the old text and its hash, or null for a new file. */
  private base: { content: string; hash: string } | null | undefined;
  private diff: FileDiff | null = null;
  private blocked: string | null = null;
  private conflict = false;
  private error: string | null = null;
  private confirmingPartial = false;
  private busy: 'read' | 'apply' | 'undo' | null = null;
  private disabled = false;
  private expanded = true;
  private showAll = false;
  private opId: string | undefined;
  private kind: 'create' | 'modify' | undefined;
  private counts = { added: 0, removed: 0 };

  constructor(
    readonly key: string,
    readonly edit: ParsedEdit,
    private readonly ask: Ask,
    private readonly onChange: () => void
  ) {
    ({ host: this.host, root: this.root } = createHost('diff-card'));
  }

  /** Restores a saved state, or reads the file for a fresh card. */
  async init(record: CardRecord | undefined): Promise<void> {
    if (record && record.state !== 'pending') {
      this.state = record.state;
      this.opId = record.opId;
      this.kind = record.kind;
      this.counts = { added: record.added ?? 0, removed: record.removed ?? 0 };
      this.render();
      return;
    }
    if (!record) void this.persist();
    await this.load();
  }

  /** Pending, readable, not blocked, and not already identical on disk. */
  get applicable(): boolean {
    return (
      this.state === 'pending' &&
      !this.disabled &&
      this.busy === null &&
      this.base !== undefined &&
      this.blocked === null &&
      this.diff !== null &&
      this.diff.status !== 'unchanged'
    );
  }

  get suspectedPartial(): boolean {
    return this.edit.suspectedPartial;
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.render();
  }

  /** Reads the file and recomputes the diff. */
  async load(): Promise<void> {
    this.busy = 'read';
    this.render();
    const outcome = await this.ask<RequestOutcome<ReadResult>>({
      type: 'chat-read',
      path: this.edit.path
    });
    this.busy = null;
    if (outcome?.ok) {
      this.base = { content: outcome.result.content, hash: outcome.result.hash };
      this.error = null;
    } else if (outcome?.error.code === 'not-found') {
      this.base = null;
      this.error = null;
    } else if (outcome && BLOCKING.has(outcome.error.code)) {
      this.blocked = FILE_ERROR_LABELS[outcome.error.code as FileErrorCode];
      this.error = failureText(outcome.error);
    } else {
      this.error = failureText(outcome?.error);
    }
    if (this.base !== undefined) {
      this.diff = diffFile(this.base?.content ?? null, this.edit.content);
      this.counts = { added: this.diff.added, removed: this.diff.removed };
    }
    this.render();
    this.onChange();
  }

  /**
   * Writes the file. A suspected partial file needs a second click. Resolves true once
   * written; false if it needs another click, conflicted, or failed.
   */
  async apply(): Promise<boolean> {
    if (!this.applicable || !this.diff) return false;
    if (this.edit.suspectedPartial && !this.confirmingPartial) {
      this.confirmingPartial = true;
      this.render();
      return false;
    }
    this.busy = 'apply';
    this.error = null;
    this.render();
    const outcome = await this.ask<RequestOutcome<WriteResult>>({
      type: 'chat-write',
      path: this.edit.path,
      content: this.edit.content,
      ...(this.base && { baseHash: this.base.hash })
    });
    this.busy = null;
    this.confirmingPartial = false;

    if (outcome?.ok) {
      this.state = 'applied';
      this.opId = outcome.result.opId;
      this.kind = outcome.result.kind;
      this.conflict = false;
      void this.persist();
      this.render();
      this.onChange();
      return true;
    }
    const code = outcome?.error.code;
    if (code === 'conflict' || code === 'exists') {
      // Someone changed the file after the diff was shown. Show the new diff instead.
      this.conflict = true;
      await this.load();
      return false;
    }
    if (code && BLOCKING.has(code)) this.blocked = FILE_ERROR_LABELS[code as FileErrorCode];
    this.error = failureText(outcome?.error);
    this.render();
    this.onChange();
    return false;
  }

  reject(): void {
    if (this.state !== 'pending' || this.disabled) return;
    this.state = 'rejected';
    void this.persist();
    this.render();
    this.onChange();
  }

  async undo(): Promise<void> {
    if (this.state !== 'applied' || !this.opId || this.disabled || this.busy) return;
    this.busy = 'undo';
    this.error = null;
    this.render();
    const outcome = await this.ask<RequestOutcome<UndoResult>>({
      type: 'chat-undo',
      opId: this.opId
    });
    this.busy = null;
    if (outcome?.ok || outcome?.error.code === 'already-undone') {
      this.state = 'undone';
      void this.persist();
    } else if (outcome?.error.code === 'conflict') {
      this.error =
        'The file changed since Bridge wrote it. Undo it in the Bridge app, which asks before discarding your edit.';
    } else if (outcome?.error.code === 'unknown-op') {
      this.error = 'Bridge no longer has a backup of this change.';
    } else {
      this.error = failureText(outcome?.error);
    }
    this.render();
    this.onChange();
  }

  private persist(): Promise<unknown> {
    const record: CardRecord = {
      state: this.state,
      path: this.edit.path,
      updatedAt: Date.now(),
      ...(this.opId && { opId: this.opId }),
      ...(this.kind && { kind: this.kind }),
      added: this.counts.added,
      removed: this.counts.removed
    };
    return this.ask({ type: 'card-set', key: this.key, record });
  }

  get badges(): Badge[] {
    const badges: Badge[] = [];
    if (this.blocked) badges.push('blocked');
    else if (this.conflict) badges.push('conflict');
    else if (this.diff) badges.push(this.diff.status);
    if (this.edit.suspectedPartial) badges.push('partial?');
    return badges;
  }

  private meta(): HTMLElement {
    const label =
      this.kind === 'create' || this.diff?.status === 'new'
        ? 'New file'
        : this.diff?.status === 'unchanged'
          ? 'No changes'
          : 'Modified';
    if (this.busy === 'read' && this.base === undefined)
      return h('span', { class: 'meta' }, 'Reading…');
    if (this.base === undefined && this.state === 'pending') return h('span', { class: 'meta' });
    return h(
      'span',
      { class: 'meta' },
      `${label} · `,
      h('span', { class: 'plus' }, `+${formatCount(this.counts.added)}`),
      ' ',
      h('span', { class: 'minus' }, `−${formatCount(this.counts.removed)}`)
    );
  }

  private badgeElements(): HTMLElement[] {
    const tones: Record<Badge, string | undefined> = {
      new: 'success',
      modified: undefined,
      unchanged: undefined,
      conflict: 'warning',
      blocked: 'danger',
      'partial?': 'warning'
    };
    return this.badges.map((badge) =>
      h('span', { class: 'badge', attrs: { 'data-tone': tones[badge] } }, badge)
    );
  }

  private messageLine(): HTMLElement | null {
    if (this.error) {
      return h(
        'p',
        { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } },
        this.error
      );
    }
    return null;
  }

  private diffBody(): HTMLElement | null {
    if (!this.diff || !this.expanded) return null;
    const lines = this.diff.lines;
    const body = h('div', { class: 'body' });
    if (lines.length === 0) {
      body.append(
        h(
          'div',
          { class: 'row', attrs: { 'data-kind': 'empty' } },
          this.diff.status === 'unchanged' ? 'Same as the file on disk.' : 'Empty file.'
        )
      );
      return body;
    }
    const shown = this.showAll ? lines : lines.slice(0, DIFF_RENDER_LIMIT);
    const prefix = { add: '+ ', del: '- ', ctx: '  ', hunk: '' } as const;
    for (const line of shown) {
      body.append(
        h('div', { class: 'row', attrs: { 'data-kind': line.kind } }, prefix[line.kind] + line.text)
      );
    }
    const wrapper = h('div', {}, body);
    if (shown.length < lines.length) {
      wrapper.append(
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
    return wrapper;
  }

  private footer(): HTMLElement {
    let hint = 'Review before applying.';
    let tone: string | undefined;
    if (this.disabled) hint = 'Session ended. Start a new one to apply.';
    else if (this.blocked) hint = 'Bridge won’t write this file.';
    else if (this.confirmingPartial) {
      hint =
        'This looks like part of a file. Applying replaces the whole file. Click again to apply anyway.';
      tone = 'warning';
    } else if (this.edit.suspectedPartial) {
      hint = 'This may be only part of the file (it has a placeholder like “…rest unchanged”).';
      tone = 'warning';
    } else if (this.conflict) {
      hint = 'The file was updated since this diff was first shown. This is the new diff.';
      tone = 'warning';
    } else if (this.diff?.status === 'unchanged') hint = 'Already up to date.';

    const retry =
      this.base === undefined && !this.blocked && this.busy === null
        ? h(
            'button',
            { class: 'btn', attrs: { type: 'button' }, onClick: () => void this.load() },
            'Retry'
          )
        : null;
    const reject = h(
      'button',
      {
        class: 'btn',
        attrs: { type: 'button' },
        onClick: () => this.reject()
      },
      'Reject'
    );
    reject.disabled = this.disabled || this.busy !== null;
    const apply = h(
      'button',
      {
        class: 'btn btn-primary btn-lg',
        attrs: { type: 'button' },
        onClick: () => void this.apply()
      },
      this.busy === 'apply' ? 'Applying…' : this.confirmingPartial ? 'Apply anyway' : 'Apply'
    );
    apply.disabled = !this.applicable;
    return h(
      'div',
      { class: 'footer' },
      h('p', { class: 'hint', attrs: { 'data-tone': tone } }, hint),
      retry,
      reject,
      apply
    );
  }

  private render(): void {
    const path = h('span', { class: 'path', attrs: { title: this.edit.path } }, this.edit.path);
    let card: HTMLElement;

    if (this.state === 'pending') {
      const toggle = this.diff
        ? h(
            'button',
            {
              class: 'link',
              attrs: { type: 'button', 'aria-expanded': String(this.expanded) },
              onClick: () => {
                this.expanded = !this.expanded;
                this.render();
              }
            },
            this.expanded ? 'Hide diff' : 'Show diff',
            icon('chevron')
          )
        : null;
      card = h(
        'div',
        { class: 'card', attrs: { 'data-state': 'pending' } },
        h(
          'div',
          { class: 'header' },
          icon('file'),
          path,
          ...this.badgeElements(),
          this.meta(),
          h('span', { class: 'spacer' }),
          toggle
        ),
        this.messageLine(),
        this.diffBody(),
        this.footer()
      );
    } else if (this.state === 'applied') {
      const undo = h(
        'button',
        { class: 'btn', attrs: { type: 'button' }, onClick: () => void this.undo() },
        this.busy === 'undo' ? 'Undoing…' : 'Undo'
      );
      undo.disabled = this.disabled || this.busy !== null || !this.opId;
      card = h(
        'div',
        { class: 'card', attrs: { 'data-state': 'applied' } },
        h(
          'div',
          { class: 'header' },
          icon('check', 'icon-success'),
          path,
          this.meta(),
          h('span', { class: 'spacer' }),
          h('span', { class: 'word', attrs: { 'data-tone': 'success' } }, 'Applied'),
          undo
        ),
        this.messageLine()
      );
    } else {
      card = h(
        'div',
        { class: 'card struck', attrs: { 'data-state': this.state } },
        h(
          'div',
          { class: 'header' },
          icon('file'),
          path,
          this.meta(),
          h('span', { class: 'spacer' }),
          h('span', { class: 'word' }, this.state === 'rejected' ? 'Rejected' : 'Undone')
        )
      );
    }

    const style = this.root.querySelector('style');
    this.root.replaceChildren(...(style ? [style] : []), card);
  }
}
