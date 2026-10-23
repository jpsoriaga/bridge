import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FundingGoal, SupportLinks } from '../config/funding';
import { Support } from './Support';

const GOALS: FundingGoal[] = [
  { id: 'store', title: 'Store fee', detail: 'x', goal: 5, raised: 2, cadence: 'one-time' },
  { id: 'domain', title: 'Domain', detail: 'y', goal: 12, raised: 12, cadence: 'per year' }
];

const NONE: SupportLinks = { githubSponsors: '', kofi: '', gcashQr: '' };

describe('Support', () => {
  it('hides every button whose link is empty', () => {
    render(<Support goals={GOALS} links={NONE} />);
    expect(screen.queryByRole('link', { name: /sponsors/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /ko-fi/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gcash/i })).toBeNull();
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  it('shows only the buttons that have a link', () => {
    render(<Support goals={GOALS} links={{ ...NONE, kofi: 'https://ko-fi.com/example' }} />);
    expect(screen.getByRole('link', { name: /ko-fi/i }).getAttribute('href')).toBe(
      'https://ko-fi.com/example'
    );
    expect(screen.queryByRole('link', { name: /sponsors/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /gcash/i })).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('shows progress until a goal is reached, then "Funded"', () => {
    render(<Support goals={GOALS} links={NONE} />);
    const [store, domain] = screen.getAllByRole('listitem');
    expect(within(store!).getByText('$2 / $5')).toBeTruthy();
    expect(within(store!).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    expect(within(store!).queryByText(/funded/i)).toBeNull();
    expect(within(domain!).getByText('Funded, thank you!')).toBeTruthy();
    expect(within(domain!).queryByRole('progressbar')).toBeNull();
  });

  it('opens the GCash QR in a dialog that traps focus and closes with Escape', () => {
    render(<Support goals={GOALS} links={{ ...NONE, gcashQr: '/gcash-qr.png' }} />);
    const opener = screen.getByRole('button', { name: /gcash/i });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: /gcash/i });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const img = within(dialog).getByRole('img', { name: /qr code/i });
    expect(img.getAttribute('src')).toBe('/gcash-qr.png');
    expect(img.getAttribute('loading')).toBe('lazy');

    // The close button is the only control, so Tab and Shift+Tab stay on it.
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    // Focus that escaped the dialog is pulled back in.
    opener.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes the dialog from its close button', () => {
    render(<Support goals={GOALS} links={{ ...NONE, gcashQr: '/gcash-qr.png' }} />);
    fireEvent.click(screen.getByRole('button', { name: /gcash/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
