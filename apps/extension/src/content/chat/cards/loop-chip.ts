import { LOOP_STATE_LABELS, type LoopState, type PauseReason } from '@bridge/shared';
import { h } from './dom';
import { createHost } from './host';

const PAUSE_SHORT: Record<PauseReason, string> = {
  gated: 'gated file',
  partial: 'partial file',
  conflict: 'file changed',
  blocked: 'edit blocked',
  'not-allowed': 'command not allowed',
  failure: 'command failed',
  'too-big': 'message too big',
  'page-error': 'page error',
  disconnected: 'app disconnected',
  navigated: 'left the chat',
  'step-limit': 'step limit',
  'send-failed': 'send failed'
};

export interface ChipState {
  state: LoopState;
  step: number;
  limit: number;
  reason?: PauseReason;
}

/**
 * The floating chip while Full auto is on: "Full auto · 3 / 10", the state, and **Stop**.
 * Fixed to the bottom-right corner, in its own closed shadow root like the cards.
 */
export class LoopChip {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;

  constructor(private readonly onStop: () => void) {
    ({ host: this.host, root: this.root } = createHost('loop-chip'));
    this.host.hidden = true;
  }

  /** Null hides it. */
  render(chip: ChipState | null): void {
    const style = this.root.querySelector('style');
    if (!chip) {
      this.host.hidden = true;
      this.root.replaceChildren(...(style ? [style] : []));
      return;
    }
    if (!this.host.isConnected) document.body.append(this.host);
    this.host.hidden = false;
    const label =
      chip.state === 'paused' && chip.reason
        ? `Paused · ${PAUSE_SHORT[chip.reason]}`
        : chip.state === 'idle'
          ? 'On'
          : LOOP_STATE_LABELS[chip.state];
    const tone =
      chip.state === 'paused'
        ? 'warning'
        : chip.state === 'stopped' || chip.state === 'idle'
          ? undefined
          : 'success';
    const stop = h(
      'button',
      { class: 'btn btn-danger', attrs: { type: 'button' }, onClick: () => this.onStop() },
      'Stop'
    );
    stop.disabled = chip.state === 'stopped';
    this.root.replaceChildren(
      ...(style ? [style] : []),
      h(
        'div',
        { class: 'chip', attrs: { role: 'status' } },
        h('span', { class: 'dot', attrs: { 'data-tone': tone } }),
        h('span', { class: 'chip-label' }, 'Full auto'),
        h('span', { class: 'chip-count' }, `${chip.step} / ${chip.limit}`),
        h('span', { class: 'chip-state' }, label),
        stop
      )
    );
  }
}
