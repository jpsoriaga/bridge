import type { DiffCard } from './diff-card';
import { h } from './dom';
import { createHost } from './host';

/** Cards Apply all takes: pending, readable, changed, and not suspected partial. */
export function applyAllTargets(cards: readonly DiffCard[]): DiffCard[] {
  return cards.filter((card) => card.applicable && !card.suspectedPartial);
}

/** Cards Undo all takes: applied ones, newest write first. */
export function undoAllTargets(cards: readonly DiffCard[]): DiffCard[] {
  return cards.filter((card) => card.state === 'applied').reverse();
}

/**
 * Under the last diff card of a reply. **Apply all** shows with two or more applicable
 * files: it applies them in order and stops at the first one that doesn't go through.
 * **Undo all** shows with two or more applied files (Auto-apply does this a lot): it undoes
 * them newest first and stops at the first that can't be undone. Either card says why.
 */
export class MessageBar {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private running: 'apply' | 'undo' | null = null;
  private stoppedAt: { action: 'apply' | 'undo'; path: string } | null = null;

  constructor(private readonly cards: readonly DiffCard[]) {
    ({ host: this.host, root: this.root } = createHost('message-bar'));
  }

  get visible(): boolean {
    return (
      this.running !== null ||
      applyAllTargets(this.cards).length >= 2 ||
      undoAllTargets(this.cards).length >= 2
    );
  }

  async applyAll(): Promise<void> {
    if (this.running) return;
    await this.each('apply', applyAllTargets(this.cards), async (card) => {
      return (await card.apply()) === 'applied';
    });
  }

  async undoAll(): Promise<void> {
    if (this.running) return;
    await this.each('undo', undoAllTargets(this.cards), async (card) => {
      await card.undo();
      return card.state === 'undone';
    });
  }

  private async each(
    action: 'apply' | 'undo',
    targets: DiffCard[],
    fn: (card: DiffCard) => Promise<boolean>
  ): Promise<void> {
    this.running = action;
    this.stoppedAt = null;
    this.render();
    for (const card of targets) {
      if (!(await fn(card))) {
        this.stoppedAt = { action, path: card.edit.path };
        break;
      }
    }
    this.running = null;
    this.render();
  }

  render(): void {
    const applyCount = applyAllTargets(this.cards).length;
    const undoCount = undoAllTargets(this.cards).length;
    const style = this.root.querySelector('style');
    if (!this.visible && !this.stoppedAt) {
      this.root.replaceChildren(...(style ? [style] : []));
      this.host.hidden = true;
      return;
    }
    this.host.hidden = false;

    const buttons: HTMLElement[] = [];
    if (undoCount >= 2 || this.running === 'undo') {
      const undo = h(
        'button',
        { class: 'btn', attrs: { type: 'button' }, onClick: () => void this.undoAll() },
        this.running === 'undo' ? 'Undoing…' : `Undo all (${undoCount})`
      );
      undo.disabled = this.running !== null || undoCount < 1;
      buttons.push(undo);
    }
    if (applyCount >= 2 || this.running === 'apply') {
      const apply = h(
        'button',
        {
          class: 'btn btn-primary',
          attrs: { type: 'button' },
          onClick: () => void this.applyAll()
        },
        this.running === 'apply' ? 'Applying…' : `Apply all (${applyCount})`
      );
      apply.disabled = this.running !== null || applyCount < 2;
      buttons.push(apply);
    }

    const hint = this.stoppedAt
      ? `Stopped at ${this.stoppedAt.path}. Its card says why.`
      : applyCount >= 2
        ? 'Applies each file in order and stops at the first problem.'
        : 'Undoes this reply’s edits, newest first.';
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
        ...buttons
      )
    );
    this.root.replaceChildren(...(style ? [style] : []), card);
  }
}
