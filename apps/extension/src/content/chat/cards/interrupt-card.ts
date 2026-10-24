import { buildContinuation, type Interruption } from '@bridge/shared';
import { insertIntoComposer } from '../composer';
import { cardButton, h, icon, renderCard } from './dom';
import { createHost } from './host';

/** What the card does on the page, injected so tests can use a fake. */
export interface InterruptActions {
  /** The page offers its own Continue generating for this reply. */
  canContinue(): boolean;
  /** Presses it. False if it's gone. */
  continueReply(): boolean;
  insert(text: string): ReturnType<typeof insertIntoComposer>;
}

/**
 * Under a reply that was cut off (an error, the network, or Bridge stopping a reply stuck
 * after sleep): where it stopped, the file it didn't finish (which Bridge doesn't apply),
 * and a way on. The page's own **Continue generating** comes first when it's there, since it
 * keeps the same reply; **Insert continuation** puts a request to carry on in the composer
 * without sending it. In Full auto the loop does one of them itself, and the card says so.
 */
export class InterruptCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private disabled = false;
  private inserted = false;
  private continued = false;
  /** Full auto asked for the continuation. */
  private autoSent = false;
  private error: string | null = null;

  constructor(
    readonly interruption: Interruption,
    private readonly actions: InterruptActions = {
      canContinue: () => false,
      continueReply: () => false,
      insert: insertIntoComposer
    }
  ) {
    ({ host: this.host, root: this.root } = createHost('interrupt-card'));
    this.render();
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.render();
  }

  markAutoSent(): void {
    this.autoSent = true;
    this.render();
  }

  /** The continuation prompt, as Insert continuation puts it in the composer. */
  get text(): string {
    return buildContinuation(this.interruption);
  }

  insert(): void {
    const result = this.actions.insert(this.text);
    if (!result.ok) {
      this.error =
        result.error === 'no-composer'
          ? 'Bridge can’t find the message box on this page.'
          : 'Bridge couldn’t insert the request. Click in the message box and try again.';
    } else {
      this.inserted = true;
      this.error = null;
    }
    this.render();
  }

  continueReply(): void {
    if (this.actions.continueReply()) {
      this.continued = true;
      this.error = null;
    } else {
      this.error = 'The page’s Continue generating button is gone. Insert a continuation instead.';
    }
    this.render();
  }

  private render(): void {
    const { marker, cutOff } = this.interruption;
    const title = 'The chat’s reply was interrupted';
    const canContinue = !this.continued && this.actions.canContinue();
    const hint = this.disabled
      ? 'Session ended.'
      : this.autoSent
        ? 'Full auto asked the chat to continue.'
        : this.continued
          ? 'The chat is continuing the same reply.'
          : this.inserted
            ? 'The request is in the message box. Press send.'
            : canContinue
              ? 'Continue generating keeps the same reply. Or ask the chat to continue.'
              : 'Bridge applies only what came through whole. Ask the chat to continue.';
    const insert = cardButton(
      canContinue ? 'secondary' : 'primary',
      {
        attrs: { 'data-focus': 'continuation' },
        onClick: () => this.insert()
      },
      this.inserted || this.autoSent ? 'Insert again' : 'Insert continuation'
    );
    insert.disabled = this.disabled;
    const pageContinue = canContinue
      ? cardButton(
          'primary',
          {
            attrs: { 'data-focus': 'continue' },
            onClick: () => this.continueReply()
          },
          'Continue generating'
        )
      : null;
    if (pageContinue) pageContinue.disabled = this.disabled;
    const card = h(
      'div',
      { class: 'card', attrs: { 'data-kind': 'interrupt', role: 'group', 'aria-label': title } },
      h('div', { class: 'header' }, icon('alert'), h('span', { class: 'title' }, title)),
      h(
        'ul',
        { class: 'files' },
        h(
          'li',
          { class: 'issue' },
          marker ? `It stopped after ${marker}.` : 'It stopped before its first Bridge marker.'
        ),
        cutOff
          ? h('li', { class: 'issue' }, `${cutOff} was cut off, so Bridge won’t apply it.`)
          : null
      ),
      this.error
        ? h('p', { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } }, this.error)
        : null,
      h(
        'div',
        { class: 'footer' },
        h(
          'p',
          {
            class: 'hint',
            attrs: {
              'data-tone': this.inserted || this.autoSent || this.continued ? undefined : 'warning'
            }
          },
          hint
        ),
        insert,
        pageContinue
      )
    );
    renderCard(this.root, card);
  }
}
