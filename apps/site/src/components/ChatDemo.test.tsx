import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDemo, FINAL_STEP, PATH } from './ChatDemo';

function stubMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduced && query.includes('reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }))
  );
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible')
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

// One step per act(), as React schedules the next timer only after it renders the last.
function tick(ms: number) {
  for (let t = 0; t < ms; t += 50) {
    act(() => {
      vi.advanceTimersByTime(50);
    });
  }
}

const figure = () => document.querySelector('figure')!;
const step = () => figure().dataset.step;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setHidden(false);
});

describe('the hero demo', () => {
  it('shows the React example', () => {
    stubMotion(true);
    render(<ChatDemo />);
    expect(PATH).toBe('src/components/Button.tsx');
    expect(screen.getByText('Add a loading state to the Button component')).toBeTruthy();
    expect(screen.getByText(`@@FILE ${PATH}@@`)).toBeTruthy();
    expect(figure().textContent).toContain('disabled={disabled || loading}');
    expect(figure().textContent).toContain('aria-busy={loading}');
    expect(screen.getByText('my-react-app')).toBeTruthy();
    expect(screen.getByText('~/code/my-react-app')).toBeTruthy();
  });

  it('draws Reject and Apply the same size', () => {
    stubMotion(true);
    render(<ChatDemo />);
    const size = (name: string) =>
      [...document.querySelector(`[data-demo-button="${name}"]`)!.classList]
        .filter((c) => /^(btn|btn-(sm|lg|xl)|min-w-.*|h-.*|w-.*|px-.*)$/.test(c))
        .sort();
    expect(size('apply')).toEqual(size('reject'));
    expect(size('apply')).toContain('btn-lg');
    expect(document.querySelector('[data-demo-button="apply"]')?.classList).toContain(
      'btn-primary'
    );
    expect(document.querySelector('[data-demo-button="reject"]')?.classList).not.toContain(
      'btn-primary'
    );
  });

  it('fades every part out together, then resets them unseen', () => {
    stubMotion(false);
    render(<ChatDemo />);
    tick(2_500);
    expect(step()).toBe('exit');
    expect(document.querySelector('.demo-stage')?.getAttribute('data-phase')).toBe('exit');
    tick(500);
    expect(document.querySelector('.demo-stage')?.getAttribute('data-phase')).toBe('reset');
    expect(document.querySelectorAll('.demo-part[data-on]')).toHaveLength(0);
  });

  it('shows the applied card and the passing command, still, under reduced motion', () => {
    stubMotion(true);
    render(<ChatDemo />);
    expect(step()).toBe(FINAL_STEP);
    expect(figure().dataset.playing).toBe('false');
    expect(screen.getByText('· just now')).toBeTruthy();
    expect(screen.getByText('· just now').parentElement?.hasAttribute('data-on')).toBe(true);
    expect(screen.getByText('exit 0').hasAttribute('data-on')).toBe(true);
    expect(screen.getByText('running').hasAttribute('data-on')).toBe(false);
    const rows = [...document.querySelectorAll('[data-demo="activity"] > li')];
    expect(rows.map((row) => row.textContent)).toEqual([
      `Modified ${PATH}Just now · via chat`,
      expect.stringMatching(/^\$npm testrunningexit 0/),
      'Ran npm test · exit 0Just now · 0.8s'
    ]);
    expect(rows.every((row) => row.hasAttribute('data-on'))).toBe(true);
    // Nothing to pause.
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
    tick(30_000);
    expect(step()).toBe(FINAL_STEP);
  });

  it('loops, and stops while the tab is hidden', () => {
    stubMotion(false);
    render(<ChatDemo />);
    expect(figure().dataset.playing).toBe('true');
    tick(2_500);
    expect(step()).toBe('exit');
    tick(500);
    expect(step()).toBe('empty');
    tick(500);
    expect(step()).toBe('ask');

    setHidden(true);
    expect(figure().dataset.playing).toBe('false');
    tick(30_000);
    expect(step()).toBe('ask');

    setHidden(false);
    tick(1_000);
    expect(step()).not.toBe('ask');
  });

  it('pauses on the final frame from its button', () => {
    stubMotion(false);
    render(<ChatDemo />);
    tick(4_000);
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(step()).toBe(FINAL_STEP);
    tick(30_000);
    expect(step()).toBe(FINAL_STEP);
    expect(screen.getByRole('button', { name: /play/i }).getAttribute('aria-pressed')).toBe('true');
  });
});
