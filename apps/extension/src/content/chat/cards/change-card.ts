import {
  FILE_ERROR_LABELS,
  type DeleteResult,
  type FileErrorCode,
  type FileRename,
  type Mode,
  type RenameResult,
  type StatResult,
  type Trigger,
  type UndoResult
} from '@bridge/shared';
import type { CardState, ChangeCardRecord, RequestOutcome } from '../../../messages';
import { failureText, modeTag, type Ask } from './diff-card';
import {
  copyButton,
  formatFixedBadge,
  formatSize,
  formatTime,
  h,
  icon,
  renderCard,
  resultIcon,
  resultWord
} from './dom';
import { createHost } from './host';

/** A `@@DELETE` or `@@RENAME` from the chat. */
export type FileChange = { kind: 'delete'; path: string } | ({ kind: 'rename' } & FileRename);

/** Refusals that mean this change can't happen at all, whatever the user clicks. */
const BLOCKING: ReadonlySet<string> = new Set<FileErrorCode>([
  'invalid-path',
  'absolute-path',
  'traversal',
  'denied',
  'outside-root',
  'hardlink',
  'not-a-file',
  'too-large',
  'project-missing'
]);

export type ChangeBadge = 'delete' | 'rename' | 'missing' | 'exists' | 'conflict' | 'blocked';

/**
 * One `@@DELETE` or `@@RENAME`. It checks the file when it appears (its size and hash, and
 * for a rename whether the new path is free), and changes it only on a click, in every
 * mode: Auto-apply and Full auto never delete or move a file. The app backs the file up
 * first, so Undo puts it back.
 */
export class ChangeCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  state: CardState = 'pending';
  /** What `stat` found: the file's size and hash. Null: it isn't there. */
  private base: StatResult | null | undefined;
  private blocked: string | null = null;
  /** For a rename: something else is at the new path already. */
  private taken = false;
  private conflict = false;
  private error: string | null = null;
  private busy: 'check' | 'apply' | 'undo' | null = null;
  private disabled = false;
  private opId: string | undefined;
  private appliedAt: number | undefined;
  private mode: Mode | null = null;
  private checking: Promise<void> = Promise.resolve();
  /** Applied by Full auto ("Also approve automatically"), not a click. */
  auto = false;
  /** The marker was missing its closing `@@`. Set before `init`. */
  formatFixed = false;

  constructor(
    readonly key: string,
    readonly change: FileChange,
    private readonly ask: Ask,
    private readonly onChange: () => void
  ) {
    ({ host: this.host, root: this.root } = createHost('change-card'));
  }

  /** The path the file is at before the change. */
  get path(): string {
    return this.change.kind === 'delete' ? this.change.path : this.change.from;
  }

  /** How the change reads in a summary: "src/a.ts (deleted)", "a.ts → b.ts (renamed)". */
  get summary(): string {
    return this.change.kind === 'delete'
      ? `${this.change.path} (deleted)`
      : `${this.change.from} → ${this.change.to} (renamed)`;
  }

  /** Paths this card cares about on disk, for "changed on disk" refreshes. */
  get paths(): string[] {
    return this.change.kind === 'delete' ? [this.change.path] : [this.change.from, this.change.to];
  }

  async init(record: ChangeCardRecord | undefined): Promise<void> {
    if (record && record.state !== 'pending') {
      this.state = record.state;
      this.opId = record.opId;
      this.appliedAt = record.appliedAt;
      this.auto = record.auto === true;
      this.render();
      return;
    }
    if (!record) void this.persist();
    await this.check();
  }

  ready(): Promise<void> {
    return this.checking;
  }

  /** Pending, checked, and nothing in the way. */
  get applicable(): boolean {
    return (
      this.state === 'pending' &&
      !this.disabled &&
      this.busy === null &&
      this.base != null &&
      this.blocked === null &&
      !this.taken
    );
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.render();
  }

  setMode(mode: Mode | null): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.render();
  }

  /** A file it touches changed on disk: check again, and say so if it moved under us. */
  async refresh(): Promise<void> {
    if (this.state !== 'pending' || this.busy !== null || this.base === undefined) return;
    const before = this.base?.hash ?? null;
    await this.check();
    if ((this.base?.hash ?? null) !== before) {
      this.conflict = true;
      this.render();
    }
  }

  /** Reads the file's size and hash, and for a rename whether the new path is free. */
  check(): Promise<void> {
    this.checking = this.stat();
    return this.checking;
  }

  private async stat(): Promise<void> {
    this.busy = 'check';
    this.render();
    const outcome = await this.ask<RequestOutcome<StatResult>>({
      type: 'chat-stat',
      path: this.path
    });
    this.busy = null;
    this.blocked = null;
    if (outcome?.ok) {
      this.base = outcome.result;
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
    if (this.change.kind === 'rename' && this.base) {
      const target = await this.ask<RequestOutcome<StatResult>>({
        type: 'chat-stat',
        path: this.change.to
      });
      // A case-only rename (App.tsx → app.tsx) on a case-insensitive disk finds the same
      // file at the new path. The app tells the two apart; here, same hash and a path that
      // differs only by case is let through.
      const sameFile =
        target?.ok === true &&
        target.result.hash === this.base.hash &&
        this.change.to.toLowerCase() === this.change.from.toLowerCase();
      this.taken = target?.ok === true && !sameFile;
      if (!target?.ok && target && target.error.code !== 'not-found') {
        if (BLOCKING.has(target.error.code)) {
          this.blocked = FILE_ERROR_LABELS[target.error.code as FileErrorCode];
          this.error = failureText(target.error);
        }
      }
    }
    this.render();
    this.onChange();
  }

  /**
   * Deletes or moves the file: on a click, or from Full auto when "Also approve
   * automatically → deletes and renames" is on (the app checks that setting itself).
   */
  async apply(options: { trigger?: Trigger; loopId?: string } = {}): Promise<boolean> {
    if (!this.applicable || !this.base) return false;
    const trigger = options.trigger ?? 'click';
    this.busy = 'apply';
    this.error = null;
    this.render();
    const { hash } = this.base;
    const labels = { trigger, ...(options.loopId && { loopId: options.loopId }) };
    const outcome =
      this.change.kind === 'delete'
        ? await this.ask<RequestOutcome<DeleteResult>>({
            type: 'chat-delete',
            path: this.change.path,
            baseHash: hash,
            ...labels
          })
        : await this.ask<RequestOutcome<RenameResult>>({
            type: 'chat-rename',
            from: this.change.from,
            to: this.change.to,
            baseHash: hash,
            ...labels
          });
    this.busy = null;
    if (outcome?.ok) {
      this.state = 'applied';
      this.auto = trigger === 'auto';
      this.opId = outcome.result.opId;
      this.appliedAt = Date.now();
      this.conflict = false;
      void this.persist();
      this.render();
      this.onChange();
      return true;
    }
    const code = outcome?.error.code;
    if (code === 'conflict' || code === 'not-found' || code === 'exists') {
      // The file (or the new path) changed since the card looked. Look again.
      this.conflict = code === 'conflict';
      await this.check();
      this.error = failureText(outcome?.error);
      this.render();
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
        this.change.kind === 'delete'
          ? 'Something new is at that path now. Undo it in the Bridge app, which asks before replacing it.'
          : 'The file changed after Bridge moved it. Undo it in the Bridge app, which asks before discarding that.';
    } else if (outcome?.error.code === 'unknown-op') {
      this.error = 'Bridge no longer has a backup of this change.';
    } else {
      this.error = failureText(outcome?.error);
    }
    this.render();
    this.onChange();
  }

  get badges(): ChangeBadge[] {
    if (this.blocked) return ['blocked'];
    if (this.base === null) return ['missing'];
    if (this.taken) return ['exists'];
    const badges: ChangeBadge[] = [this.change.kind];
    if (this.conflict) badges.push('conflict');
    return badges;
  }

  private persist(): Promise<unknown> {
    const record: ChangeCardRecord = {
      card: 'change',
      state: this.state,
      updatedAt: Date.now(),
      ...(this.opId && { opId: this.opId }),
      ...(this.auto && this.state === 'applied' && { auto: true as const }),
      ...(this.appliedAt !== undefined &&
        this.state !== 'pending' && {
          appliedAt: this.appliedAt
        })
    };
    return this.ask({ type: 'card-set', key: this.key, record });
  }

  /** The path, or `old → new`, as text. */
  private title(): HTMLElement {
    if (this.change.kind === 'delete') {
      return h('span', { class: 'path', attrs: { title: this.change.path } }, this.change.path);
    }
    const { from, to } = this.change;
    return h(
      'span',
      { class: 'path rename', attrs: { title: `${from} → ${to}` } },
      h('span', { class: 'from' }, from),
      h('span', { class: 'arrow', attrs: { 'aria-label': 'to' } }, ' → '),
      h('span', { class: 'to' }, to)
    );
  }

  private meta(): HTMLElement {
    if (this.busy === 'check' && this.base === undefined) {
      return h('span', { class: 'meta' }, 'Checking…');
    }
    if (!this.base) return h('span', { class: 'meta' });
    return h('span', { class: 'meta' }, formatSize(this.base.size));
  }

  private badgeElements(): HTMLElement[] {
    const tones: Record<ChangeBadge, string | undefined> = {
      delete: 'danger',
      rename: undefined,
      missing: 'warning',
      exists: 'warning',
      conflict: 'warning',
      blocked: 'danger'
    };
    return this.badges.map((badge) =>
      h('span', { class: 'badge', attrs: { 'data-tone': tones[badge] } }, badge)
    );
  }

  private footer(): HTMLElement {
    const deleting = this.change.kind === 'delete';
    let hint = deleting
      ? 'Bridge will delete this file. It keeps a backup, so you can undo.'
      : 'Bridge will move this file. You can undo it.';
    let tone: string | undefined = deleting ? 'danger' : undefined;
    if (this.disabled) {
      hint = 'This session isn’t active in this tab.';
      tone = undefined;
    } else if (this.blocked) {
      hint = 'Bridge won’t change this file.';
      tone = undefined;
    } else if (this.base === null) {
      hint = 'There’s no file at this path, so there’s nothing to change.';
      tone = undefined;
    } else if (this.taken && this.change.kind === 'rename') {
      hint = `Something is already at ${this.change.to}. Bridge won’t replace it.`;
      tone = 'warning';
    } else if (this.conflict) {
      hint = 'The file changed on disk since this card first checked it.';
      tone = 'warning';
    } else if (this.mode === 'auto-apply') {
      hint = `${deleting ? 'Deletes' : 'Renames'} always need your click, even in this mode. ${hint}`;
    } else if (this.mode === 'full-auto') {
      hint = `${deleting ? 'Deletes' : 'Renames'} need your click unless the app allows Full auto to approve them. ${hint}`;
    }

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
    const label = deleting
      ? this.busy === 'apply'
        ? 'Deleting…'
        : 'Delete file'
      : this.busy === 'apply'
        ? 'Renaming…'
        : 'Rename';
    const apply = h(
      'button',
      {
        class: deleting ? 'btn btn-danger btn-lg' : 'btn btn-primary btn-lg',
        attrs: { type: 'button', 'data-focus': 'apply' },
        onClick: () => void this.apply()
      },
      label
    );
    apply.disabled = !this.applicable;
    const retry =
      this.base === undefined && !this.blocked && this.busy === null
        ? h(
            'button',
            {
              class: 'btn',
              attrs: { type: 'button', 'data-focus': 'retry' },
              onClick: () => void this.check()
            },
            'Retry'
          )
        : null;
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
    const deleting = this.change.kind === 'delete';
    const kindIcon = icon(deleting ? 'trash' : 'arrow');
    const group = {
      role: 'group',
      'aria-label': deleting
        ? `Delete ${this.path}`
        : `Rename ${this.path} to ${(this.change as FileRename).to}`
    };
    const message = this.error
      ? h('p', { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } }, this.error)
      : null;
    let card: HTMLElement;

    if (this.state === 'pending') {
      card = h(
        'div',
        {
          class: 'card',
          attrs: { 'data-state': 'pending', 'data-kind': this.change.kind, ...group }
        },
        h(
          'div',
          { class: 'header' },
          kindIcon,
          this.title(),
          copyButton(this.path),
          ...this.badgeElements(),
          this.formatFixed ? formatFixedBadge() : null,
          this.meta(),
          h('span', { class: 'spacer' })
        ),
        message,
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
      const result = deleting ? 'delete' : 'rename';
      card = h(
        'div',
        { class: 'card', attrs: { 'data-state': 'applied', 'data-result': result, ...group } },
        h(
          'div',
          { class: 'header' },
          resultIcon(result),
          this.title(),
          copyButton(this.path),
          h('span', { class: 'spacer' }),
          ...resultWord(result, this.auto),
          this.appliedAt !== undefined
            ? h('span', { class: 'time' }, formatTime(this.appliedAt))
            : null,
          undo
        ),
        message
      );
    } else {
      card = h(
        'div',
        { class: 'card struck', attrs: { 'data-state': this.state, ...group } },
        h(
          'div',
          { class: 'header' },
          kindIcon,
          this.title(),
          h('span', { class: 'spacer' }),
          h('span', { class: 'word' }, this.state === 'rejected' ? 'Rejected' : 'Undone')
        )
      );
    }
    renderCard(this.root, card);
  }
}
