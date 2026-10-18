import { h, renderCard } from './dom';
import { createHost } from './host';

export interface Notice {
  text: string;
  tone?: 'warning';
  action?: { label: string; onClick: () => void };
}

/**
 * A one-line notice at the top of the page, in its own closed shadow root: "Session active
 * in another tab" with **Move here**, or "Reload the page" after Bridge itself reloaded.
 */
export class PageNotice {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;

  constructor() {
    ({ host: this.host, root: this.root } = createHost('page-notice'));
    this.host.hidden = true;
  }

  /** Null hides it. */
  render(notice: Notice | null): void {
    if (!notice) {
      this.host.hidden = true;
      renderCard(this.root, h('span'));
      return;
    }
    if (!this.host.isConnected) document.body.append(this.host);
    this.host.hidden = false;
    const action = notice.action
      ? h(
          'button',
          {
            class: 'btn',
            attrs: { type: 'button', 'data-focus': 'action' },
            onClick: notice.action.onClick
          },
          notice.action.label
        )
      : null;
    renderCard(
      this.root,
      h(
        'div',
        { class: 'notice', attrs: { role: 'status', 'data-tone': notice.tone } },
        h('span', {}, notice.text),
        action
      )
    );
  }
}
