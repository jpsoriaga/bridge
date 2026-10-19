import {
  diffFile,
  FILE_ERROR_LABELS,
  FILE_ERROR_MESSAGES,
  looksBinary,
  matchTrailingNewline,
  MAX_FILE_BYTES,
  MODE_LABELS,
  type FileDiff,
  type FileErrorCode,
  type Mode,
  type ParsedEdit,
  type ReadResult,
  type Trigger,
  type UndoResult,
  type WriteResult
} from '@bridge/shared';
import type { CardState, DiffCardRecord, RequestOutcome, WorkerRequest } from '../../../messages';
import {
  copyButton,
  formatCount,
  formatFixedBadge,
  formatTime,
  h,
  icon,
  renderCard,
  resultIcon,
  resultWord
} from './dom';
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
  'hardlink',
  'not-a-file',
  'binary',
  'too-large',
  'encoding'
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
 * How an apply ended. `confirm`: a suspected partial file needs a second click. `held`: an
 * automatic apply left it for a click (partial, conflict, blocked, gated, too big).
 */
export type ApplyOutcome = 'applied' | 'confirm' | 'held' | 'failed' | 'not-applicable';

/** Why an edit waits for a click instead of being applied on its own. */
export type Hold = 'gated' | 'partial' | 'conflict' | 'blocked';

const HOLD_TEXT: Record<Hold, string> = {
  gated: 'gated file',
  partial: 'may be partial',
  conflict: 'changed on disk',
  blocked: 'blocked'
};

/** A small mode label at the start of a card's hint line. */
export function modeTag(mode: Mode | null): HTMLElement | null {
  return mode ? h('span', { class: 'mode' }, MODE_LABELS[mode]) : null;
}

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
  /** Applied by Auto-apply or Full auto, not a click. */
  auto = false;
  /** Why Auto-apply or Full auto left this card for a click. */
  hold: Hold | null = null;
  private mode: Mode | null = null;
  private loading: Promise<void> = Promise.resolve();
  private appliedAt: number | undefined;
  /**
   * The same reply edits this path more than once. `earlier`: a later card has another
   * version (Apply all skips this one). `later`: this is the last version.
   */
  duplicate: 'earlier' | 'later' | null = null;

  constructor(
    readonly key: string,
    readonly edit: ParsedEdit,
    private readonly ask: Ask,
    private readonly onChange: () => void
  ) {
    ({ host: this.host, root: this.root } = createHost('diff-card'));
  }

  /** Restores a saved state, or reads the file for a fresh card. */
  async init(record: DiffCardRecord | undefined): Promise<void> {
    if (record && record.state !== 'pending') {
      this.state = record.state;
      this.opId = record.opId;
      this.kind = record.kind;
      this.auto = record.auto === true;
      this.appliedAt = record.appliedAt;
      this.counts = { added: record.added ?? 0, removed: record.removed ?? 0 };
      this.render();
      return;
    }
    if (!record) void this.persist();
    // Content Bridge would never write: say so without reading or diffing it.
    const unwritable = looksBinary(this.edit.content)
      ? 'binary'
      : new TextEncoder().encode(this.edit.content).length > MAX_FILE_BYTES
        ? 'too-large'
        : null;
    if (unwritable) {
      this.blocked = FILE_ERROR_LABELS[unwritable];
      this.error =
        unwritable === 'binary'
          ? 'This block has binary content. Bridge only writes text files.'
          : 'This file is over 1 MB. Bridge won’t write files that big.';
      this.expanded = false;
      this.render();
      this.onChange();
      return;
    }
    await this.load();
  }

  /** Marks this card as one of several edits to the same path in its reply. */
  setDuplicate(duplicate: 'earlier' | 'later' | null): void {
    if (this.duplicate === duplicate) return;
    this.duplicate = duplicate;
    this.render();
  }

  /**
   * The file changed on disk. A pending card reads it again; if it isn't what the diff
   * was made against, the new diff shows with a "changed on disk" note, before Apply would
   * find out the hard way.
   */
  async refresh(): Promise<void> {
    if (this.state !== 'pending' || this.busy !== null || this.base === undefined) return;
    if (this.blocked) return;
    const before = this.base?.hash ?? null;
    await this.load();
    const after = this.base === undefined ? before : (this.base?.hash ?? null);
    if (after !== before) {
      this.conflict = true;
      this.render();
      this.onChange();
    }
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

  /** The app's mode, for the label on the card. Null while disconnected. */
  setMode(mode: Mode | null): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.render();
  }

  /** Waits for the read this card started when it appeared (or the latest re-read). */
  ready(): Promise<void> {
    return this.loading;
  }

  /** Why an automatic apply would leave this card alone, or null if it would apply it. */
  autoHold(): Hold | null {
    if (this.blocked) return 'blocked';
    if (this.conflict) return 'conflict';
    if (this.edit.suspectedPartial) return 'partial';
    if (new TextEncoder().encode(this.edit.content).length > MAX_FILE_BYTES) return 'blocked';
    return this.hold;
  }

  /** A few words on why it's held, for the follow-up message. */
  get holdText(): string {
    const hold = this.hold ?? this.autoHold();
    return hold ? HOLD_TEXT[hold] : 'not applied';
  }

  /** Reads the file and recomputes the diff. */
  load(): Promise<void> {
    this.loading = this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
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
      // Compare what would really be written: the file keeps its final newline (or lack).
      const current = this.base?.content ?? null;
      this.diff = diffFile(current, matchTrailingNewline(this.edit.content, current));
      this.counts = { added: this.diff.added, removed: this.diff.removed };
    }
    this.render();
    this.onChange();
  }

  /**
   * Writes the file. On a click, a suspected partial file needs a second click. An
   * automatic apply (`trigger: 'auto'`) never confirms anything: it leaves partial,
   * conflicting, blocked, gated and oversized files on the card for a click (`held`).
   */
  async apply(options: { trigger?: Trigger; loopId?: string } = {}): Promise<ApplyOutcome> {
    const trigger = options.trigger ?? 'click';
    if (!this.applicable || !this.diff) return 'not-applicable';
    if (trigger === 'auto') {
      const hold = this.autoHold();
      if (hold) {
        this.hold = hold;
        this.render();
        return 'held';
      }
    } else if (this.edit.suspectedPartial && !this.confirmingPartial) {
      this.confirmingPartial = true;
      this.render();
      return 'confirm';
    }
    this.busy = 'apply';
    this.error = null;
    this.render();
    const outcome = await this.ask<RequestOutcome<WriteResult>>({
      type: 'chat-write',
      path: this.edit.path,
      content: this.edit.content,
      ...(this.base && { baseHash: this.base.hash }),
      trigger,
      ...(options.loopId && { loopId: options.loopId })
    });
    this.busy = null;
    this.confirmingPartial = false;

    if (outcome?.ok) {
      this.state = 'applied';
      this.opId = outcome.result.opId;
      this.kind = outcome.result.kind;
      this.auto = trigger === 'auto';
      this.appliedAt = Date.now();
      this.conflict = false;
      this.hold = null;
      void this.persist();
      this.render();
      this.onChange();
      return 'applied';
    }
    const code = outcome?.error.code;
    if (code === 'conflict' || code === 'exists') {
      // Someone changed the file after the diff was shown. Show the new diff instead.
      this.conflict = true;
      if (trigger === 'auto') this.hold = 'conflict';
      await this.load();
      return trigger === 'auto' ? 'held' : 'failed';
    }
    if (code === 'gated' || code === 'mode') {
      // The app wants a click for this one. It stays pending, with a note saying why.
      this.hold = code === 'gated' ? 'gated' : null;
      this.error = code === 'mode' ? failureText(outcome?.error) : null;
      this.render();
      this.onChange();
      return 'held';
    }
    if (code && BLOCKING.has(code)) this.blocked = FILE_ERROR_LABELS[code as FileErrorCode];
    this.error = failureText(outcome?.error);
    this.render();
    this.onChange();
    return 'failed';
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
    const record: DiffCardRecord = {
      state: this.state,
      path: this.edit.path,
      updatedAt: Date.now(),
      ...(this.opId && { opId: this.opId }),
      ...(this.kind && { kind: this.kind }),
      ...(this.auto && this.state === 'applied' && { auto: true as const }),
      ...(this.appliedAt !== undefined &&
        this.state !== 'pending' && { appliedAt: this.appliedAt }),
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
    else if (this.hold === 'gated') {
      hint =
        'This file can change what commands do, so it needs your click in every mode. Review it, then Apply.';
      tone = 'warning';
    } else if (this.confirmingPartial) {
      hint =
        'This looks like part of a file. Applying replaces the whole file. Click again to apply anyway.';
      tone = 'warning';
    } else if (this.edit.suspectedPartial) {
      hint = 'This may be only part of the file (it has a placeholder like “…rest unchanged”).';
      tone = 'warning';
    } else if (this.conflict) {
      hint = 'The file changed on disk since this diff was first shown. This is the new diff.';
      tone = 'warning';
    } else if (this.duplicate === 'earlier') {
      hint =
        'This reply has another version of this file further down. Apply all uses the last one.';
      tone = 'warning';
    } else if (this.duplicate === 'later') {
      hint = 'This reply changes this file more than once. This is the last version.';
      tone = 'warning';
    } else if (this.diff?.status === 'unchanged') hint = 'Already up to date. Nothing to apply.';

    const retry =
      this.base === undefined && !this.blocked && this.busy === null
        ? h(
            'button',
            {
              class: 'btn',
              attrs: { type: 'button', 'data-focus': 'retry' },
              onClick: () => void this.load()
            },
            'Retry'
          )
        : null;
    const reject = h(
      'button',
      {
        class: 'btn',
        attrs: { type: 'button', 'data-focus': 'reject' },
        onClick: () => this.reject()
      },
      'Reject'
    );
    reject.disabled = this.disabled || this.busy !== null;
    const apply = h(
      'button',
      {
        class: 'btn btn-primary btn-lg',
        attrs: { type: 'button', 'data-focus': 'apply' },
        onClick: () => void this.apply()
      },
      this.busy === 'apply' ? 'Applying…' : this.confirmingPartial ? 'Apply anyway' : 'Apply'
    );
    apply.disabled = !this.applicable;
    return h(
      'div',
      { class: 'footer' },
      h('p', { class: 'hint', attrs: { 'data-tone': tone } }, modeTag(this.mode), hint),
      retry,
      reject,
      apply
    );
  }

  private render(): void {
    const path = h('span', { class: 'path', attrs: { title: this.edit.path } }, this.edit.path);
    const copy = copyButton(this.edit.path);
    const group = { role: 'group', 'aria-label': `Edit to ${this.edit.path}` };
    let card: HTMLElement;

    if (this.state === 'pending') {
      const toggle = this.diff
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
            this.expanded ? 'Hide diff' : 'Show diff',
            icon('chevron')
          )
        : null;
      card = h(
        'div',
        { class: 'card', attrs: { 'data-state': 'pending', ...group } },
        h(
          'div',
          { class: 'header' },
          icon('file'),
          path,
          copy,
          ...this.badgeElements(),
          this.edit.formatFixed ? formatFixedBadge() : null,
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
        {
          class: 'btn',
          attrs: { type: 'button', 'data-focus': 'undo' },
          onClick: () => void this.undo()
        },
        this.busy === 'undo' ? 'Undoing…' : 'Undo'
      );
      undo.disabled = this.disabled || this.busy !== null || !this.opId;
      const result = this.kind ?? (this.diff?.status === 'new' ? 'create' : 'modify');
      card = h(
        'div',
        { class: 'card', attrs: { 'data-state': 'applied', 'data-result': result, ...group } },
        h(
          'div',
          { class: 'header' },
          resultIcon(result),
          path,
          copy,
          this.meta(),
          h('span', { class: 'spacer' }),
          ...resultWord(result, this.auto),
          this.appliedAt !== undefined
            ? h('span', { class: 'time' }, formatTime(this.appliedAt))
            : null,
          undo
        ),
        this.messageLine()
      );
    } else {
      card = h(
        'div',
        { class: 'card struck', attrs: { 'data-state': this.state, ...group } },
        h(
          'div',
          { class: 'header' },
          icon('file'),
          path,
          copy,
          this.meta(),
          h('span', { class: 'spacer' }),
          h('span', { class: 'word' }, this.state === 'rejected' ? 'Rejected' : 'Undone')
        )
      );
    }

    renderCard(this.root, card);
  }
}
