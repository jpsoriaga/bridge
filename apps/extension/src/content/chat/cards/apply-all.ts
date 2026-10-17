import type { DiffCard } from './diff-card';
import { h } from './dom';
import { createHost } from './host';

/** Cards Apply all takes: pending, readable, changed, and not suspected partial. */
export function applyAllTargets(cards: readonly DiffCard[]): DiffCard[] {
  return cards.filter((card) => card.applicable && !card.suspectedPartial);
}

/**
 * Shown under a reply with two or more applicable files. Applies them in order and stops
 * at the first one that doesn't go through; that card shows why.
 */
export class ApplyAllBar {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private running = false;
  private stoppedAt: string | null = null;

  constructor(private readonly cards: readonly DiffCard[]) {
    ({ host: this.host, root: this.root } = createHost('apply-all'));
  }

  get visible(): boolean {
    return this.running || applyAllTargets(this.cards).length >= 2;
  }

  async run(): Promise<void> {
    if (this.running) return;
    const targets = applyAllTargets(this.cards);
    this.running = true;
    this.stoppedAt = null;
    this.render();
    for (const card of targets) {
      if (!(await card.apply())) {
        this.stoppedAt = card.edit.path;
        break;
      }
    }
    this.running = false;
    this.render();
  }

  render(): void {
    const count = applyAllTargets(this.cards).length;
    const style = this.root.querySelector('style');
    if (!this.visible && !this.stoppedAt) {
      this.root.replaceChildren(...(style ? [style] : []));
      this.host.hidden = true;
      return;
    }
    this.host.hidden = false;
    const button = h(
      'button',
      { class: 'btn btn-primary', attrs: { type: 'button' }, onClick: () => void this.run() },
      this.running ? 'Applying…' : `Apply all (${count})`
    );
    button.disabled = this.running || count < 2;
    const hint = this.stoppedAt
      ? `Stopped at ${this.stoppedAt}. Its card says why.`
      : 'Applies each file in order and stops at the first problem.';
    const card = h(
      'div',
      { class: 'card', attrs: { 'data-kind': 'bar' } },
      h(
        'div',
        { class: 'footer' },
        h(
          'p',
          { class: 'hint', attrs: { 'data-tone': this.stoppedAt ? 'warning' : undefined } },
          hint
        ),
        button
      )
    );
    this.root.replaceChildren(...(style ? [style] : []), card);
  }
}
