import {
  LOOP_STATE_LABELS,
  MODE_LABELS,
  type LoopState,
  type Mode,
  type PauseReason
} from '@bridge/shared';
import type { ChipCorner } from '../../../messages';
import { h, renderCard } from './dom';
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
  'send-failed': 'send failed',
  'needs-click': 'needs your click',
  'app-restarted': 'app restarted',
  slept: 'after sleep'
};

export const CHIP_CORNERS: readonly ChipCorner[] = [
  'bottom-right',
  'bottom-left',
  'top-left',
  'top-right'
];

export interface ChipState {
  mode: Mode;
  /** The Full auto loop, while it isn't idle (or Full auto is on). */
  loop: { state: LoopState; step: number; limit: number; reason?: PauseReason } | null;
}

/** The corner nearest a point in the viewport. */
export function nearestCorner(x: number, y: number, width: number, height: number): ChipCorner {
  const top = y < height / 2;
  const left = x < width / 2;
  return `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}`;
}

/**
 * The floating chip while a session is active: the app's mode, and in Full auto the step
 * counter, the state and **Stop**. It sits in a corner of the page, in its own closed
 * shadow root like the cards; drag it by its label (or press the label and use the arrow
 * keys) to move it to another corner, which is remembered.
 */
export class LoopChip {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private corner: ChipCorner = 'bottom-right';
  private last: ChipState | null = null;

  constructor(
    private readonly onStop: () => void,
    private readonly onCorner: (corner: ChipCorner) => void = () => {}
  ) {
    ({ host: this.host, root: this.root } = createHost('loop-chip'));
    this.host.hidden = true;
    this.host.dataset.corner = this.corner;
  }

  /** Puts the chip in a corner (from storage, or after a drag). */
  setCorner(corner: ChipCorner): void {
    this.corner = corner;
    this.host.dataset.corner = corner;
  }

  private move(corner: ChipCorner): void {
    if (corner === this.corner) return;
    this.setCorner(corner);
    this.onCorner(corner);
  }

  /** Null hides it. */
  render(chip: ChipState | null): void {
    this.last = chip;
    if (!chip) {
      this.host.hidden = true;
      renderCard(this.root, h('span'));
      return;
    }
    if (!this.host.isConnected) document.body.append(this.host);
    this.host.hidden = false;
    const { loop } = chip;
    const running = loop !== null;

    const handle = h(
      'button',
      {
        class: 'chip-handle link',
        attrs: {
          type: 'button',
          'aria-label': `Bridge, ${MODE_LABELS[chip.mode]}. Drag, or use the arrow keys, to move to another corner.`,
          'data-focus': 'handle'
        }
      },
      h('span', { class: 'dot', attrs: { 'data-tone': this.tone(chip) } }),
      h('span', { class: 'chip-label' }, MODE_LABELS[chip.mode])
    );
    this.draggable(handle);

    let stop: HTMLButtonElement | null = null;
    if (running) {
      stop = h(
        'button',
        {
          class: 'btn btn-danger',
          attrs: { type: 'button', 'data-focus': 'stop' },
          onClick: () => this.onStop()
        },
        'Stop'
      );
      stop.disabled = loop.state === 'stopped';
    }
    renderCard(
      this.root,
      h(
        'div',
        { class: 'chip', attrs: { role: 'status' } },
        handle,
        running ? h('span', { class: 'chip-count' }, `${loop.step} / ${loop.limit}`) : null,
        running ? h('span', { class: 'chip-state' }, this.label(loop)) : null,
        stop
      )
    );
  }

  private tone(chip: ChipState): string | undefined {
    const state = chip.loop?.state;
    if (state === 'paused') return 'warning';
    if (state && state !== 'stopped' && state !== 'idle') return 'success';
    return undefined;
  }

  private label(loop: NonNullable<ChipState['loop']>): string {
    if (loop.state === 'paused' && loop.reason) return `Paused · ${PAUSE_SHORT[loop.reason]}`;
    return loop.state === 'idle' ? 'On' : LOOP_STATE_LABELS[loop.state];
  }

  /** Pointer drag to the nearest corner; arrow keys step to a neighbouring one. */
  private draggable(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const chip = handle.parentElement;
      handle.setPointerCapture(event.pointerId);
      chip?.setAttribute('data-dragging', 'true');
      const up = (end: PointerEvent) => {
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        chip?.removeAttribute('data-dragging');
        const moved = Math.hypot(end.clientX - event.clientX, end.clientY - event.clientY) > 8;
        if (moved) {
          this.move(nearestCorner(end.clientX, end.clientY, innerWidth, innerHeight));
        }
      };
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (event) => {
      const [vertical, horizontal] = this.corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
      const next: Partial<Record<string, ChipCorner>> = {
        ArrowUp: `top-${horizontal}`,
        ArrowDown: `bottom-${horizontal}`,
        ArrowLeft: `${vertical}-left`,
        ArrowRight: `${vertical}-right`
      };
      const corner = next[event.key];
      if (!corner) return;
      event.preventDefault();
      this.move(corner);
      if (this.last) this.render(this.last);
    });
  }
}
