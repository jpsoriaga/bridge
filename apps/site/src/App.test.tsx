import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { resetReleaseCache } from './lib/releases';

const SECTIONS = [
  'Let the ChatGPT web chat edit your local project.',
  'Set it up once, then keep chatting',
  'You choose how much happens on its own',
  'The chat suggests. You stay in charge.',
  'Made for programmers in the same boat',
  'Get Bridge',
  'Questions people ask',
  'Help Bridge reach more people'
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(new Response('[]', { status: 200 }))
  );
});

afterEach(() => {
  resetReleaseCache();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function renderApp() {
  render(<App />);
  // Let the release request settle.
  await act(async () => {});
}

describe.each(['light', 'dark'] as const)('the page in the %s theme', (theme) => {
  beforeEach(() => {
    document.documentElement.dataset.theme = theme;
  });

  it('renders every section', async () => {
    await renderApp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(SECTIONS[0]);
    for (const title of SECTIONS.slice(1)) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy();
    }
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(
      screen
        .getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark' })
        .getAttribute('aria-checked')
    ).toBe('true');
  });

  it('draws the footer wordmark as an SVG hidden from assistive technology', async () => {
    await renderApp();
    const wordmark = document.querySelector('footer svg.wordmark');
    expect(wordmark?.textContent).toBe('Bridge');
    expect(wordmark?.getAttribute('aria-hidden')).toBe('true');
    expect(wordmark?.getAttribute('viewBox')).toMatch(/^[\d.-]+ [\d.-]+ [\d.]+ [\d.]+$/);
  });
});

describe('the page', () => {
  it('links the Releases page when no release is published', async () => {
    await renderApp();
    expect(screen.getByText('There’s no published release yet.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /open the releases page/i }).getAttribute('href')).toBe(
      'https://github.com/jpsoriaga/bridge/releases'
    );
  });

  it('switches and remembers the theme with the toggle', async () => {
    await renderApp();
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('bridge-theme')).toBe('dark');
    // The switch follows <html data-theme> through a MutationObserver.
    await act(async () => {});
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'Theme' }), { key: 'ArrowRight' });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('bridge-theme')).toBeNull();
  });

  it('works when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    await renderApp();
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    vi.restoreAllMocks();
  });

  it('has one call to action in the hero, and no badge above the title', async () => {
    await renderApp();
    const hero = screen.getByRole('region', { name: /edit your local project/i });
    expect(within(hero).queryByText(/now in beta/i)).toBeNull();
    const buttons = hero.querySelectorAll('a.btn, button.btn');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe('Download');
    expect(buttons[0]?.classList.contains('btn-accent')).toBe(true);
    expect(buttons[0]?.getAttribute('href')).toBe('#download');
    expect(within(hero).getByRole('link', { name: 'GitHub' }).classList.contains('btn')).toBe(
      false
    );
    expect(within(hero).queryByRole('link', { name: /beta\.md/i })).toBeNull();
  });

  it('credits the author in the footer', async () => {
    await renderApp();
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText(/made by/i).textContent).toBe(
      'Made by John Patrick Soriaga, 2026'
    );
    expect(
      within(footer).getByRole('link', { name: 'John Patrick Soriaga' }).getAttribute('href')
    ).toBe('https://jpsoriaga.me');
  });
});
