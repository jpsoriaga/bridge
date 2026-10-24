import {
  type DownloadResult,
  type FileErrorCode,
  type Mode,
  type StatResult,
  type Trigger,
  type UndoResult,
  type WriteResult
} from '@bridge/shared';
import { bytesToBase64 } from '../../../binary';
import type { BinaryCardRecord, CardState, RequestOutcome } from '../../../messages';
import { imageFor } from '../images';
import { failureText, modeTag, type Ask } from './diff-card';
import {
  cardButton,
  formatSize,
  formatTime,
  h,
  icon,
  renderCard,
  resultIcon,
  resultWord
} from './dom';
import { createHost } from './host';

/** How a save ended, for Auto-apply and Full auto. */
export type SaveOutcome = 'saved' | 'held' | 'failed' | 'not-applicable';

/** Refusals no click can get past. */
const BLOCKING: ReadonlySet<string> = new Set<FileErrorCode>([
  'invalid-path',
  'absolute-path',
  'traversal',
  'denied',
  'outside-root',
  'hardlink',
  'not-a-file',
  'too-large',
  'unsupported-type'
]);

/** The image's own address, if it's https and short enough to send: null otherwise. */
function httpsUrl(img: HTMLImageElement): string | null {
  const src = img.currentSrc || img.src;
  try {
    return new URL(src).protocol === 'https:' && src.length <= 2048 ? src : null;
  } catch {
    return null;
  }
}

/**
 * **Save to project** under an image the chat made. The path field starts with the
 * reply's `@@ASSET path@@` for this image, if it had one. Save reads the image from the
 * page (re-encoding it if the path asks for another type) and writes it through the app
 * like any change: sandbox, denylist, backup, Undo. With a path from the chat, Auto-apply
 * and Full auto save it on their own.
 */
export class AssetCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  state: CardState = 'pending';
  /** Where it goes. The user may change it until it's saved. */
  path: string;
  private busy: 'save' | 'undo' | null = null;
  private error: string | null = null;
  private blocked = false;
  private disabled = false;
  private mode: Mode | null = null;
  private opId: string | undefined;
  private kind: 'create' | 'modify' | undefined;
  private size: number | null = null;
  private appliedAt: number | undefined;
  /** Saved by Auto-apply or Full auto. */
  auto = false;
  /** Saving would replace a file: the first click says so, the second saves. */
  private confirming = false;
  /**
   * The page wouldn't hand the image over (CORS), but it has an https address: the app can
   * fetch it from there instead, on a click only, like `@@DOWNLOAD`.
   */
  private remoteUrl: string | null = null;
  private downloading = false;

  constructor(
    readonly key: string,
    /** The image on the page. The page may draw it anew; the controller keeps this current. */
    public image: HTMLImageElement,
    /** The `@@ASSET` path the chat gave this image, or null. */
    readonly suggested: string | null,
    private readonly ask: Ask,
    private readonly onChange: () => void
  ) {
    ({ host: this.host, root: this.root } = createHost('asset-card'));
    this.path = suggested ?? '';
  }

  init(record: BinaryCardRecord | undefined): void {
    if (record && record.state !== 'pending') {
      this.state = record.state;
      this.path = record.path ?? this.path;
      this.opId = record.opId;
      this.kind = record.kind;
      this.auto = record.auto === true;
      this.appliedAt = record.appliedAt;
    } else if (!record) void this.persist();
    this.render();
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

  /** Pending, with a path the chat gave: Auto-apply and Full auto may save it. */
  get automatic(): boolean {
    return this.state === 'pending' && this.suggested !== null && !this.blocked && !this.disabled;
  }

  /** "public/hero.png (image)", for the follow-up. */
  get summary(): string {
    return `${this.path} (image)`;
  }

  /**
   * Saves the image. A click on an existing file asks once more first; an automatic save
   * replaces it (the app keeps a backup). A file that changed since the check is `held`.
   */
  async save(options: { trigger?: Trigger; loopId?: string } = {}): Promise<SaveOutcome> {
    const trigger = options.trigger ?? 'click';
    const path = this.path.trim();
    if (this.state !== 'pending' || this.disabled || this.busy || !path) return 'not-applicable';
    this.busy = 'save';
    this.error = null;
    this.render();
    const image = await imageFor(this.image, path);
    if (!image.ok) {
      this.busy = null;
      this.remoteUrl = image.unreadable ? httpsUrl(this.image) : null;
      this.error = this.remoteUrl
        ? 'Bridge can’t read this image from the page: its server doesn’t allow it. Download from URL has the Bridge app fetch it from its address instead.'
        : image.error;
      this.render();
      return trigger === 'auto' ? 'held' : 'failed';
    }
    const existing = await this.ask<RequestOutcome<StatResult>>({ type: 'chat-stat', path });
    if (existing?.ok && trigger === 'click' && !this.confirming) {
      this.busy = null;
      this.confirming = true;
      this.render();
      return 'held';
    }
    if (existing && !existing.ok && existing.error.code !== 'not-found') {
      this.busy = null;
      this.fail(existing.error.code, failureText(existing.error));
      return trigger === 'auto' ? 'held' : 'failed';
    }
    const outcome = await this.ask<RequestOutcome<WriteResult>>({
      type: 'chat-write-binary',
      path,
      data: bytesToBase64(image.bytes),
      ...(existing?.ok && { baseHash: existing.result.hash }),
      trigger,
      ...(options.loopId && { loopId: options.loopId })
    });
    this.busy = null;
    this.confirming = false;
    if (outcome?.ok) {
      this.state = 'applied';
      this.path = path;
      this.opId = outcome.result.opId;
      this.kind = outcome.result.kind;
      this.size = image.bytes.length;
      this.auto = trigger === 'auto';
      this.appliedAt = Date.now();
      void this.persist();
      this.render();
      this.onChange();
      return 'saved';
    }
    this.fail(outcome?.error.code, failureText(outcome?.error));
    return trigger === 'auto' ? 'held' : 'failed';
  }

  /**
   * **Download from URL**: the app fetches the image from its https address into the path,
   * with every `@@DOWNLOAD` check (never a local address, 20 MB, type from the bytes). The
   * worker always sends it as a click; nothing does it on its own.
   */
  async downloadFromUrl(): Promise<void> {
    const path = this.path.trim();
    const url = this.remoteUrl;
    if (!url || !path || this.state !== 'pending' || this.disabled || this.busy) return;
    this.busy = 'save';
    this.downloading = true;
    this.error = null;
    this.render();
    const existing = await this.ask<RequestOutcome<StatResult>>({ type: 'chat-stat', path });
    const outcome = await this.ask<RequestOutcome<DownloadResult>>({
      type: 'chat-download',
      url,
      path,
      ...(existing?.ok && { baseHash: existing.result.hash })
    });
    this.busy = null;
    this.downloading = false;
    if (outcome?.ok) {
      this.state = 'applied';
      this.path = path;
      this.opId = outcome.result.opId;
      this.kind = outcome.result.kind;
      this.size = outcome.result.size;
      this.auto = false;
      this.appliedAt = Date.now();
      this.remoteUrl = null;
      void this.persist();
      this.render();
      this.onChange();
      return;
    }
    this.fail(outcome?.error.code, failureText(outcome?.error));
  }

  private fail(code: string | undefined, text: string): void {
    if (code && BLOCKING.has(code) && this.suggested !== null && this.path === this.suggested) {
      this.blocked = true;
    }
    this.error =
      code === 'gated'
        ? 'That file can change what commands do, so it needs your click. Click Save.'
        : text;
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
      card: 'asset',
      state: this.state,
      updatedAt: Date.now(),
      ...(this.path && { path: this.path }),
      ...(this.opId && { opId: this.opId }),
      ...(this.kind && { kind: this.kind }),
      ...(this.auto && this.state === 'applied' && { auto: true as const }),
      ...(this.appliedAt !== undefined && this.state !== 'pending' && { appliedAt: this.appliedAt })
    };
    return this.ask({ type: 'card-set', key: this.key, record });
  }

  private thumbnail(): HTMLElement {
    const src = this.image.currentSrc || this.image.src;
    return h('img', {
      class: 'thumb',
      attrs: { src, alt: '', 'aria-hidden': 'true', loading: 'lazy', referrerpolicy: 'no-referrer' }
    });
  }

  private render(): void {
    const group = { role: 'group', 'aria-label': 'Save image to project' };
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
          attrs: { 'data-kind': 'asset', 'data-state': 'applied', 'data-result': result, ...group }
        },
        h(
          'div',
          { class: 'header' },
          resultIcon(result),
          this.thumbnail(),
          h('span', { class: 'path', attrs: { title: this.path } }, this.path),
          this.size !== null ? h('span', { class: 'meta' }, formatSize(this.size)) : null,
          h('span', { class: 'spacer' }),
          ...resultWord(result, this.auto),
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
          attrs: { 'data-kind': 'asset', 'data-state': this.state, ...group }
        },
        h(
          'div',
          { class: 'header' },
          icon('image'),
          h('span', { class: 'path' }, this.path),
          h('span', { class: 'spacer' }),
          h('span', { class: 'word' }, this.state === 'rejected' ? 'Rejected' : 'Undone')
        )
      );
    } else {
      const input = h('input', {
        class: 'input mono',
        attrs: {
          type: 'text',
          value: this.path,
          placeholder: 'public/image.png',
          'aria-label': 'Save as (a path in the project)',
          spellcheck: 'false',
          'data-focus': 'path'
        }
      });
      input.disabled = this.disabled || this.busy !== null;
      input.addEventListener('input', () => {
        this.path = input.value;
        this.confirming = false;
        this.blocked = false;
        this.error = null;
        save.disabled = !this.path.trim() || this.disabled || this.busy !== null;
      });
      const save = cardButton(
        'primary',
        {
          attrs: { 'data-focus': 'save' },
          onClick: () => void this.save()
        },
        this.busy === 'save' ? 'Saving…' : this.confirming ? 'Replace' : 'Save'
      );
      save.disabled = !this.path.trim() || this.disabled || this.busy !== null || this.blocked;
      const download = this.remoteUrl
        ? cardButton(
            'primary',
            {
              attrs: { 'data-focus': 'download', title: this.remoteUrl },
              onClick: () => void this.downloadFromUrl()
            },
            this.downloading ? 'Downloading…' : 'Download from URL'
          )
        : null;
      if (download) {
        download.disabled = !this.path.trim() || this.disabled || this.busy !== null;
        // One primary action: with the download offered, Save is the secondary one.
        save.dataset.variant = 'secondary';
      }
      const hint = this.disabled
        ? 'Session ended.'
        : this.confirming
          ? `${this.path.trim()} already exists. Replace it? Bridge keeps a backup, so you can undo.`
          : this.suggested !== null && this.mode && this.mode !== 'manual'
            ? 'The chat named this path, so Bridge saves it on its own in this mode.'
            : 'Saves the image into the project. You can undo it.';
      card = h(
        'div',
        { class: 'card', attrs: { 'data-kind': 'asset', 'data-state': 'pending', ...group } },
        h(
          'div',
          { class: 'header' },
          icon('image'),
          h('span', { class: 'title' }, 'Save image to project'),
          h('span', { class: 'spacer' })
        ),
        h('div', { class: 'asset-row' }, this.thumbnail(), input),
        message,
        h(
          'div',
          { class: 'footer' },
          h(
            'p',
            { class: 'hint', attrs: { 'data-tone': this.confirming ? 'warning' : undefined } },
            modeTag(this.mode),
            hint
          ),
          save,
          download
        )
      );
    }
    renderCard(this.root, card);
  }
}
