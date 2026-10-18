import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { FILE_ERROR_CODES } from '@bridge/shared';
import { App } from './App';
import { ERROR_TEXT } from './errors';
import { entry, installBridge, makeState } from './test-utils';

// axe on the app's main screens, in both themes. jsdom computes no real colours, so
// colour contrast is checked separately against the tokens (shared tokens.test.ts).

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } }
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
  );
}

const SCREENS = ['session', 'activity', 'settings'] as const;

describe.each(['light', 'dark'] as const)('axe, %s theme', (theme) => {
  it.each(SCREENS)('the %s screen has no violations', async (view) => {
    const state = makeState({
      theme,
      mode: 'full-auto',
      loop: { loopId: 'l1', state: 'paused', step: 3, limit: 10, reason: 'needs-click' },
      onboarding: { dismissed: false, sessionStarted: false },
      allowlist: null,
      allowlistSuggestions: ['pnpm test', 'pnpm lint']
    });
    installBridge(state, [
      entry({ id: '1', opId: 'op-1', source: 'chat' }),
      entry({ id: '2', kind: 'rejected', path: '.env', op: 'read', code: 'denied' }),
      entry({ id: '3', kind: 'loop', path: '', text: 'Sent message 1 of 10.', loopId: 'l1' })
    ]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Project' });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe(theme));
    if (view !== 'session') {
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: view === 'activity' ? 'Activity' : 'Settings' })
        );
      });
    }
    expect(await violations()).toEqual([]);
  });

  it('the Activity detail view has no violations', async () => {
    installBridge(makeState({ theme }), [entry({ id: '1', opId: 'op-1' })]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('button', { name: /^src\/a\.ts, Modified/ }));
    await screen.findByRole('region', { name: 'Changes' });
    expect(await violations()).toEqual([]);
  });
});

describe('error copy', () => {
  it('has plain-language text for every error code', () => {
    for (const code of [...FILE_ERROR_CODES, 'cancelled' as const]) {
      expect(ERROR_TEXT[code], code).toMatch(/^[A-Z].{10,}\.$/);
      expect(ERROR_TEXT[code]).not.toMatch(/\b[a-z]+-[a-z]+\b(?<!e-mail)/);
    }
    expect(Object.keys(ERROR_TEXT).sort()).toEqual([...FILE_ERROR_CODES, 'cancelled'].sort());
  });
});
