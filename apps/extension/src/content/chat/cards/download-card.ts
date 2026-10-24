import {
  isAttachablePath,
  typeOfPath,
  type DownloadResult,
  type FileDownload,
  type FileErrorCode,
  type Mode,
  type ReadBinaryResult,
  type StatResult,
  type UndoResult
} from '@bridge/shared';
import { base64ToBytes } from '../../../binary';
import type { BinaryCardRecord, CardState, RequestOutcome } from '../../../messages';
import { failureText, modeTag, type Ask } from './diff-card';
import {
  cardButton,
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

/** Refusals that mean this download can't happen at all, whatever the user clicks. */
const BLOCKING: ReadonlySet<string> = new Set<FileErrorCode>([
  'invalid-path',
  'absolute-path',
  'traversal',
  'denied',
  'outside-root',
  'hardlink',
  'not-a-file',
  'not-https',
  'private-address'
]);

/** The URL as the card shows it: no query string (it may hold a token), at most 80 characters. */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const shown = `${url.protocol}//${url.host}${url.pathname}${url.search ? '?…' : ''}`;
    return shown.length > 80 ? `${shown.slice(0, 79)}…` : shown;
  } catch {
    return raw.slice(0, 80);
  }
}

/**
 * One `@@DOWNLOAD url -> path`. Downloading always needs a click, in every mode, Full auto
 * included: the app fetches the URL (https only, never this computer or the local
 * network, 20 MB at most), checks the bytes are the type the path names, refuses an SVG
 * with scripts, and writes it like any change, with a backup and Undo.
 */
export class DownloadCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  state: CardState = 'pending';
  /** What's at the path now: its hash, to replace it. Null: nothing there. */
  private base: StatResult | null | undefined;
  private blocked: string | null = null;
  private error: string | null = null;
  private busy: 'check' | 'download' | 'undo' | null = null;
  private disabled = false;
  private mode: Mode | null = null;
  private opId: string | undefined;
  private kind: 'create' | 'modify' | undefined;
  private size: number | null = null;
  private appliedAt: number | undefined;
  /** A thumbnail of what was saved, when it's an image. */
  private preview: string | null = null;
  private checking: Promise<void> = Promise.resolve();
  /** The marker was missing its closing `@@`. Set before `init`. */
  formatFixed = false;

  constructor(
    readonly key: string,
    readonly download: FileDownload,
    private readonly ask: Ask,
    private readonly onChange: () => void
  ) {
    ({ host: this.host, root: this.root } = createHost('download-card'));
  }

  get path(): string {
    return this.download.path;
  }

  /** "public/logo.svg (downloaded)", for the follow-up. */
  get summary(): string {
    return `${this.download.path} (downloaded)`;
  }

  async init(record: BinaryCardRecord | undefined): Promise<void> {
    if (record && record.state !== 'pending') {
      this.state = record.state;
      this.opId = record.opId;
      this.kind = record.kind;
      this.appliedAt = record.appliedAt;
      this.render();
      return;
    }
    if (!record) void this.persist();
    if (!/^https:\/\//i.test(this.download.url)) {
      this.blocked = 'not https';
      this.error = 'Bridge downloads only https:// links.';
    } else if (typeOfPath(this.download.path) === null) {
      this.blocked = 'file type not allowed';
      this.error =
        'Bridge downloads images, fonts, audio, video, JSON and text files only, named for their type.';
    }
    if (this.blocked) {
      this.render();
      this.onChange();
      return;
    }
    this.checking = this.check();
    await this.checking;
  }

  ready(): Promise<void> {
    return this.checking;
  }

  /** Waiting for the user's click. */
  get waiting(): boolean {
    return this.state === 'pending' && this.blocked === null;
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

  reveal(): void {
    this.host.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.root.querySelector<HTMLElement>('[data-focus="download"]')?.focus();
  }

  private async check(): Promise<void> {
    this.busy = 'check';
    this.render();
    const outcome = await this.ask<RequestOutcome<StatResult>>({
      type: 'chat-stat',
      path: this.download.path
    });
    this.busy = null;
    if (outcome?.ok) this.base = outcome.result;
    else if (outcome?.error.code === 'not-found') this.base = null;
    else if (outcome && BLOCKING.has(outcome.error.code)) {
      this.blocked = outcome.error.code;
      this.error = failureText(outcome.error);
    } else this.error = failureText(outcome?.error);
    this.render();
    this.onChange();
  }

  /** Downloads it. Only ever on the user's click: the app refuses anything else. */
  async fetch(): Promise<boolean> {
    if (this.state !== 'pending' || this.blocked || this.disabled || this.busy) return false;
    this.busy = 'download';
    this.error = null;
    this.render();
    const outcome = await this.ask<RequestOutcome<DownloadResult>>({
      type: 'chat-download',
      url: this.download.url,
      path: this.download.path,
      ...(this.base && { baseHash: this.base.hash })
    });
    this.busy = null;
    if (outcome?.ok) {
      this.state = 'applied';
      this.opId = outcome.result.opId;
      this.kind = outcome.result.kind;
      this.size = outcome.result.size;
      this.appliedAt = Date.now();
      void this.persist();
      void this.loadPreview();
      this.render();
      this.onChange();
      return true;
    }
    const code = outcome?.error.code;
    if (code === 'conflict' || code === 'exists') {
      await this.check();
      this.error = 'The file changed since Bridge looked. Check it, then download again.';
    } else {
      if (code && BLOCKING.has(code)) this.blocked = code;
      this.error = failureText(outcome?.error);
    }
    this.render();
    this.onChange();
    return false;
  }

  /** A thumbnail of the saved image, if it is one. Quietly nothing if the page refuses it. */
  private async loadPreview(): Promise<void> {
    if (!isAttachablePath(this.download.path)) return;
    const read = await this.ask<RequestOutcome<ReadBinaryResult>>({
      type: 'chat-read-binary',
      path: this.download.path
    });
    if (!read?.ok) return;
    this.preview = URL.createObjectURL(
      new Blob([base64ToBytes(read.result.data)], { type: read.result.mime })
    );
    this.render();
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
        'The file changed since Bridge saved it. Undo it in the Bridge app, which asks first.';
    } else {
      this.error = failureText(outcome?.error);
    }
    this.render();
    this.onChange();
  }

  private persist(): Promise<unknown> {
    const record: BinaryCardRecord = {
      card: 'download',
      state: this.state,
      updatedAt: Date.now(),
      ...(this.opId && { opId: this.opId }),
      ...(this.kind && { kind: this.kind }),
      ...(this.appliedAt !== undefined && this.state !== 'pending' && { appliedAt: this.appliedAt })
    };
    return this.ask({ type: 'card-set', key: this.key, record });
  }

  private title(): HTMLElement {
    return h(
      'span',
      {
        class: 'path rename',
        attrs: { title: `${displayUrl(this.download.url)} → ${this.download.path}` }
      },
      h('span', { class: 'from' }, displayUrl(this.download.url)),
      h('span', { class: 'arrow', attrs: { 'aria-label': 'to' } }, ' → '),
      h('span', { class: 'to' }, this.download.path)
    );
  }

  private render(): void {
    const group = { role: 'group', 'aria-label': `Download to ${this.download.path}` };
    const message = this.error
      ? h('p', { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } }, this.error)
      : null;
    let card: HTMLElement;
    if (this.state === 'applied') {
      const undo = cardButton(
        'secondary',
        {
          attrs: { 'data-focus': 'undo' },
          onClick: () => void this.undo()
        },
        this.busy === 'undo' ? 'Undoing…' : 'Undo'
      );
      undo.disabled = this.disabled || this.busy !== null || !this.opId;
      const result = this.kind ?? 'create';
      card = h(
        'div',
        {
          class: 'card',
          attrs: {
            'data-kind': 'download',
            'data-state': 'applied',
            'data-result': result,
            ...group
          }
        },
        h(
          'div',
          { class: 'header' },
          resultIcon(result),
          this.preview
            ? h('img', {
                class: 'thumb',
                attrs: { src: this.preview, alt: '', 'aria-hidden': 'true' }
              })
            : null,
          h('span', { class: 'path', attrs: { title: this.download.path } }, this.download.path),
          this.size !== null ? h('span', { class: 'meta' }, formatSize(this.size)) : null,
          h('span', { class: 'spacer' }),
          ...resultWord(result),
          this.appliedAt !== undefined
            ? h('span', { class: 'time' }, formatTime(this.appliedAt))
            : null,
          undo
        ),
        message
      );
    } else if (this.state !== 'pending') {
      card = h(
        'div',
        {
          class: 'card struck',
          attrs: { 'data-kind': 'download', 'data-state': this.state, ...group }
        },
        h(
          'div',
          { class: 'header' },
          icon('download'),
          this.title(),
          h('span', { class: 'spacer' }),
          h('span', { class: 'word' }, this.state === 'rejected' ? 'Rejected' : 'Undone')
        )
      );
    } else {
      const badge = this.blocked
        ? h('span', { class: 'badge', attrs: { 'data-tone': 'danger' } }, 'blocked')
        : h(
            'span',
            { class: 'badge', attrs: { 'data-tone': this.base ? 'warning' : undefined } },
            this.base ? 'replaces' : 'download'
          );
      const reject = cardButton(
        'secondary',
        {
          attrs: { 'data-focus': 'reject' },
          onClick: () => this.reject()
        },
        'Reject'
      );
      reject.disabled = this.disabled || this.busy !== null;
      const download = cardButton(
        'primary',
        {
          attrs: { 'data-focus': 'download' },
          onClick: () => void this.fetch()
        },
        this.busy === 'download' ? 'Downloading…' : 'Download'
      );
      download.disabled =
        this.disabled || this.busy !== null || this.blocked !== null || this.base === undefined;
      const hint = this.disabled
        ? 'This session isn’t active in this tab.'
        : this.blocked
          ? 'Bridge won’t download this.'
          : `Downloads always need your click, in every mode. Bridge checks it’s really a ${typeOfPath(this.download.path)?.toUpperCase() ?? ''} file${this.base ? ` and backs up the ${formatSize(this.base.size)} file it replaces` : ''}.`;
      card = h(
        'div',
        { class: 'card', attrs: { 'data-kind': 'download', 'data-state': 'pending', ...group } },
        h(
          'div',
          { class: 'header' },
          icon('download'),
          this.title(),
          copyButton(this.download.path),
          badge,
          this.formatFixed ? formatFixedBadge() : null,
          h('span', { class: 'spacer' })
        ),
        message,
        h(
          'div',
          { class: 'footer' },
          h(
            'p',
            { class: 'hint', attrs: { 'data-tone': this.base ? 'warning' : undefined } },
            modeTag(this.mode),
            hint
          ),
          reject,
          download
        )
      );
    }
    renderCard(this.root, card);
  }
}
