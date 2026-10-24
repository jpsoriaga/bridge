import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityView, filterActivity, groupActivity } from './ActivityView';
import { App, applyTheme } from './App';
import type { DesktopState } from '../../preload/api';
import { ACTIVITY_KINDS, kindsOf } from './errors';
import { toastsFor } from './Loop';
import { Onboarding, onboardingSteps } from './Onboarding';
import { ModeSection } from './SessionView';
import { SettingsView } from './SettingsView';
import { entry, installBridge, makeState } from './test-utils';

afterEach(cleanup);

describe('Onboarding', () => {
  const fresh = makeState({
    paired: false,
    status: 'not-paired',
    project: null,
    allowlist: null,
    onboarding: { dismissed: false, sessionStarted: false }
  });

  it('ticks off each step as it happens', () => {
    expect(onboardingSteps(fresh).map((s) => s.done)).toEqual([false, false, false, false]);
    const paired = { ...fresh, paired: true };
    expect(onboardingSteps(paired).map((s) => s.done)).toEqual([true, false, false, false]);
    const project = { ...paired, project: { name: 'app', path: '~/app' } };
    expect(onboardingSteps(project).map((s) => s.done)).toEqual([true, true, false, false]);
    const missing = { ...project, project: { ...project.project, missing: true as const } };
    expect(onboardingSteps(missing)[1]!.done).toBe(false);
    const commands = { ...project, allowlist: [] };
    expect(onboardingSteps(commands).map((s) => s.done)).toEqual([true, true, true, false]);
    const done = { ...commands, onboarding: { dismissed: false, sessionStarted: true } };
    expect(onboardingSteps(done).every((s) => s.done)).toBe(true);
  });

  it('shows the next step’s hint and action, and can be dismissed', () => {
    const { bridge } = installBridge(fresh);
    const steps: string[] = [];
    render(<Onboarding state={fresh} onGo={(step) => steps.push(step)} />);
    expect(screen.getByText('0 of 4 done')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    expect(steps).toEqual(['pair']);
    fireEvent.click(screen.getByRole('button', { name: 'Close the checklist' }));
    expect(bridge.setOnboardingDismissed).toHaveBeenCalledWith(true);
  });

  it('shows in the app until dismissed, and Help brings it back', async () => {
    const t = installBridge(fresh);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Get started' })).toBeTruthy();
    act(() => t.push({ ...fresh, onboarding: { dismissed: true, sessionStarted: false } }));
    expect(screen.queryByRole('heading', { name: 'Get started' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Getting started' }));
    expect(t.bridge.setOnboardingDismissed).toHaveBeenCalledWith(false);
    act(() => t.menu('onboarding'));
    expect(t.bridge.setOnboardingDismissed).toHaveBeenCalledTimes(2);
  });
});

describe('Activity', () => {
  const rows = [
    entry({ id: '1', kind: 'modify', path: 'src/a.ts', opId: 'op-1', source: 'chat' }),
    entry({ id: '2', kind: 'delete', path: 'src/old.ts', opId: 'op-2' }),
    entry({ id: '3', kind: 'rename', path: 'lib/b.ts', from: 'src/b.ts', opId: 'op-3' }),
    entry({
      id: '4',
      kind: 'run',
      path: 'pnpm test',
      op: 'run',
      runId: 'run-1',
      run: { status: 'exited', exitCode: 1, durationMs: 1200 }
    }),
    entry({ id: '5', kind: 'rejected', path: '.env', op: 'read', code: 'denied' }),
    entry({
      id: '6',
      kind: 'create',
      path: 'src/new.ts',
      opId: 'op-6',
      trigger: 'auto',
      loopId: 'loop-1'
    }),
    entry({ id: '7', kind: 'loop', path: '', text: 'Sent message 1 of 10.', loopId: 'loop-1' })
  ];

  it('sorts each row into the filter kinds', () => {
    expect(kindsOf(rows[0]!)).toEqual(['write']);
    expect(kindsOf(rows[1]!)).toEqual(['delete']);
    expect(kindsOf(rows[2]!)).toEqual(['rename']);
    expect(kindsOf(rows[3]!)).toEqual(['run']);
    expect(kindsOf(rows[4]!)).toEqual(['blocked']);
    expect(kindsOf(rows[5]!)).toEqual(['write', 'auto']);
    // Every kind matches something here.
    for (const kind of ACTIVITY_KINDS) {
      expect(filterActivity(rows, new Set([kind]), '').length).toBeGreaterThan(0);
    }
  });

  it('filters by kind and searches by path, old path included', () => {
    expect(filterActivity(rows, new Set(['delete', 'rename']), '').map((e) => e.id)).toEqual([
      '2',
      '3'
    ]);
    expect(filterActivity(rows, new Set(), 'src/b').map((e) => e.id)).toEqual(['3']);
    expect(groupActivity(rows).map((i) => i.kind)).toEqual([
      'row',
      'row',
      'row',
      'row',
      'row',
      'loop'
    ]);
  });

  it('colours file rows by what happened: green only for created, red and struck for deleted', () => {
    installBridge();
    const { container } = render(<ActivityView entries={rows} hasProject />);
    const row = (id: string) => container.querySelector(`[data-entry="${id}"]`)!;
    const verb = (id: string) => row(id).querySelector('.result-verb');
    const mark = (id: string) => row(id).querySelector('.result-icon');
    expect([verb('6')?.textContent, verb('6')?.getAttribute('data-tone')]).toEqual([
      'Created',
      'success'
    ]);
    expect(mark('6')?.getAttribute('data-tone')).toBe('success');
    expect([verb('1')?.textContent, verb('1')?.hasAttribute('data-tone')]).toEqual([
      'Modified',
      false
    ]);
    expect([verb('3')?.textContent, verb('3')?.hasAttribute('data-tone')]).toEqual([
      'Renamed',
      false
    ]);
    expect([verb('2')?.textContent, verb('2')?.getAttribute('data-tone')]).toEqual([
      'Deleted',
      'danger'
    ]);
    expect(row('2').getAttribute('data-result')).toBe('delete');
    // No check icon, and no green dot, on a modify.
    expect(row('1').querySelector('.dot')).toBeNull();
    // Commands and refusals keep their dot.
    expect(row('4').querySelector('.dot')?.getAttribute('data-tone')).toBe('danger');
  });

  it('filters with chips, clears, and shows an empty state', () => {
    installBridge();
    render(<ActivityView entries={rows} hasProject />);
    const list = () => within(screen.getByRole('list', { name: 'Activity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deletes' }));
    expect(screen.getByRole('button', { name: 'Deletes' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(list().getAllByRole('button')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by path' }), {
      target: { value: 'nothing-like-this' }
    });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(list().getAllByRole('button').length).toBe(6);
  });

  it('opens a row’s diff and undoes from it', async () => {
    const { bridge } = installBridge();
    render(<ActivityView entries={rows} hasProject />);
    fireEvent.click(screen.getByRole('button', { name: /^src\/a\.ts, Modified/ }));
    expect(await screen.findByRole('heading', { name: 'src/a.ts' })).toBeTruthy();
    expect(bridge.getOpDetail).toHaveBeenCalledWith('op-1');
    const changes = await screen.findByRole('region', { name: 'Changes' });
    expect(changes.textContent).toContain('- two');
    expect(changes.textContent).toContain('+ three');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.undo).toHaveBeenCalledWith('op-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Back to activity' }));
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  });

  it('shows a command’s full output, or says it’s gone', async () => {
    const { bridge } = installBridge();
    bridge.getRunDetail.mockResolvedValueOnce({
      argv: ['pnpm', 'test'],
      status: 'exited',
      exitCode: 1,
      durationMs: 1200,
      output: 'FAIL src/a.test.ts',
      truncated: false
    } as never);
    render(<ActivityView entries={rows} hasProject />);
    fireEvent.click(screen.getByRole('button', { name: /^pnpm test, Exit 1/ }));
    expect((await screen.findByLabelText('Output')).textContent).toBe('FAIL src/a.test.ts');
  });

  it('says what to do with no project, and with nothing yet', () => {
    installBridge();
    const { rerender } = render(<ActivityView entries={[]} hasProject={false} />);
    expect(screen.getByText('Open a project to see its activity.')).toBeTruthy();
    rerender(<ActivityView entries={[]} hasProject />);
    expect(screen.getByText(/Nothing yet/)).toBeTruthy();
    rerender(<ActivityView entries={null} hasProject />);
    expect(screen.getByLabelText('Loading activity')).toBeTruthy();
  });
});

describe('Settings forms', () => {
  it('adds an allowed command, refusing shell syntax with the reason', async () => {
    const { bridge } = installBridge();
    render(<SettingsView state={makeState()} />);
    const input = screen.getByRole('textbox', { name: 'Add an allowed command' });
    fireEvent.change(input, { target: { value: 'pnpm test && rm -rf /' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(bridge.setAllowlist).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'pnpm lint' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(bridge.setAllowlist).toHaveBeenCalledWith(['pnpm test', 'pnpm lint'])
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove pnpm test' }));
    expect(bridge.setAllowlist).toHaveBeenLastCalledWith([]);
  });

  it('pre-checks the install command among the first suggestions, and explains it', () => {
    const { bridge } = installBridge();
    render(
      <SettingsView
        state={makeState({ allowlist: null, allowlistSuggestions: ['npm install', 'npm test'] })}
      />
    );
    const install = screen.getByRole('checkbox', { name: 'npm install' });
    expect((install as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/installs only what package.json lists/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow 2 commands' }));
    expect(bridge.setAllowlist).toHaveBeenCalledWith(['npm install', 'npm test']);
  });

  it('offers the install command once for an existing list, with Add and Dismiss', () => {
    const { bridge } = installBridge();
    const { rerender } = render(
      <SettingsView state={makeState({ installNote: 'pnpm install' })} />
    );
    expect(screen.getByText(/to the allowlist\?/).textContent).toContain('pnpm install');
    fireEvent.click(screen.getByRole('button', { name: 'Add pnpm install' }));
    expect(bridge.answerInstallNote).toHaveBeenLastCalledWith(true);
    // Answered: the app stops sending it, and the note is gone.
    rerender(<SettingsView state={makeState({ installNote: null })} />);
    expect(screen.queryByText(/to the allowlist\?/)).toBeNull();
    rerender(<SettingsView state={makeState({ installNote: 'pnpm install', project: null })} />);
    rerender(<SettingsView state={makeState({ installNote: 'pnpm install' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(bridge.answerInstallNote).toHaveBeenLastCalledWith(false);
    expect(bridge.answerInstallNote).toHaveBeenCalledTimes(2);
  });

  it('offers a dev server once as a background command, with Add and Dismiss', () => {
    const { bridge } = installBridge();
    const { rerender } = render(
      <SettingsView state={makeState({ backgroundNote: 'npm run dev' })} />
    );
    expect(screen.getByText(/as a background command\?/).textContent).toContain('npm run dev');
    fireEvent.click(
      screen.getByRole('button', { name: 'Add npm run dev as a background command' })
    );
    expect(bridge.answerBackgroundNote).toHaveBeenLastCalledWith(true);
    rerender(<SettingsView state={makeState({ backgroundNote: null })} />);
    expect(screen.queryByText(/as a background command\?/)).toBeNull();
    rerender(<SettingsView state={makeState({ backgroundNote: 'npm run dev' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(bridge.answerBackgroundNote).toHaveBeenLastCalledWith(false);
  });

  it('adds a protected pattern and says when one is invalid', async () => {
    const { bridge } = installBridge();
    bridge.setDenyPatterns.mockResolvedValueOnce(false);
    render(<SettingsView state={makeState()} />);
    const input = screen.getByRole('textbox', { name: 'Add to protected files' });
    fireEvent.change(input, { target: { value: '!keep' } });
    fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText(/without “!” or “#”/)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('saves the timeouts, step limit, pause on failure and catching up after sleep', async () => {
    const { bridge } = installBridge();
    render(<SettingsView state={makeState()} />);
    const base = {
      timeoutMs: 120_000,
      installTimeoutMs: 300_000,
      stepLimit: 10,
      pauseOnFailure: false,
      catchUpAfterSleep: true
    };
    const timeout = screen.getByRole('spinbutton', { name: /Command timeout/ });
    fireEvent.change(timeout, { target: { value: '30' } });
    fireEvent.blur(timeout);
    expect(bridge.setRunSettings).toHaveBeenLastCalledWith({ ...base, timeoutMs: 30_000 });
    const install = screen.getByRole('spinbutton', { name: /Install timeout/ });
    expect((install as HTMLInputElement).value).toBe('300');
    fireEvent.change(install, { target: { value: '600' } });
    fireEvent.blur(install);
    expect(bridge.setRunSettings).toHaveBeenLastCalledWith({ ...base, installTimeoutMs: 600_000 });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pause Full auto when a command fails' }));
    expect(bridge.setRunSettings).toHaveBeenLastCalledWith({ ...base, pauseOnFailure: true });
    const catchUp = screen.getByRole('checkbox', { name: 'Catch up automatically after sleep' });
    expect((catchUp as HTMLInputElement).checked).toBe(true);
    fireEvent.click(catchUp);
    expect(bridge.setRunSettings).toHaveBeenLastCalledWith({ ...base, catchUpAfterSleep: false });
    bridge.setRunSettings.mockResolvedValueOnce(false);
    const steps = screen.getByRole('spinbutton', { name: /Step limit/ });
    fireEvent.change(steps, { target: { value: '999' } });
    fireEvent.blur(steps);
    expect(await screen.findByText(/step limit of 1–100, or Unlimited/)).toBeTruthy();
  });

  it('keeps backups for 1–90 days, and clears or opens them', async () => {
    const { bridge } = installBridge();
    render(<SettingsView state={makeState()} />);
    const days = screen.getByRole('spinbutton', { name: /Keep backups for/ });
    fireEvent.change(days, { target: { value: '120' } });
    fireEvent.blur(days);
    expect(await screen.findByText('Keep backups for 1 to 90 days.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear for this project…' }));
    expect(await screen.findByText('Deleted every backup for app.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open the backups folder' }));
    expect(bridge.openBackupsFolder).toHaveBeenCalled();
  });

  it('sets the PATH override, and warns when the login shell couldn’t be read', async () => {
    const { bridge } = installBridge();
    render(
      <SettingsView
        state={makeState({
          commandPath: {
            source: 'fallback',
            path: '/usr/bin',
            override: '',
            warning: 'Your login shell took longer than 5s to start.'
          }
        })}
      />
    );
    expect(screen.getByText(/took longer than 5s/)).toBeTruthy();
    const input = screen.getByRole('textbox', { name: 'PATH override' });
    fireEvent.change(input, { target: { value: '/opt/homebrew/bin:/usr/bin' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() =>
      expect(bridge.setPathOverride).toHaveBeenCalledWith('/opt/homebrew/bin:/usr/bin')
    );
  });

  it('sets UI guidance under Project: Auto by default, then Always or Off', () => {
    const { bridge } = installBridge();
    const { rerender } = render(<SettingsView state={makeState()} />);
    const group = screen.getByRole('radiogroup', { name: 'UI guidance' });
    expect(within(group).getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(screen.getByText(/For projects with a UI/)).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: 'Off' }));
    expect(bridge.setUiGuidance).toHaveBeenLastCalledWith('off');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(bridge.setUiGuidance).toHaveBeenLastCalledWith('always');
    rerender(<SettingsView state={makeState({ uiGuidance: 'off' })} />);
    expect(screen.getByText(/says nothing about UI design/)).toBeTruthy();
  });

  it('switches the appearance, with the keyboard too', () => {
    const { bridge } = installBridge();
    render(<SettingsView state={makeState()} />);
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(bridge.setTheme).toHaveBeenLastCalledWith('dark');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(bridge.setTheme).toHaveBeenLastCalledWith('dark');
    const root = document.createElement('html');
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('system', root);
    expect(root.dataset.theme).toBeUndefined();
  });
});

describe('Mode switch', () => {
  it('asks main, which confirms Full auto in a native dialog, and shows what main says', async () => {
    const { bridge } = installBridge();
    // The user cancels the native dialog: main answers with the mode it stayed in.
    bridge.setMode.mockResolvedValueOnce('manual');
    const { rerender } = render(<ModeSection state={makeState()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Full auto' }));
    expect(bridge.setMode).toHaveBeenCalledWith('full-auto');
    expect(screen.getByText('Confirm in the dialog to turn on Full auto.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Manual' }).getAttribute('aria-checked')).toBe(
        'true'
      )
    );
    // Confirmed: main pushes the new state.
    rerender(<ModeSection state={makeState({ mode: 'full-auto' })} />);
    expect(screen.getByRole('radio', { name: 'Full auto' }).getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(screen.getByText(/sends messages for you/)).toBeTruthy();
  });

  it('moves with the arrow keys', async () => {
    const { bridge } = installBridge();
    render(<ModeSection state={makeState()} />);
    fireEvent.keyDown(screen.getByRole('radiogroup', { name: 'Mode' }), { key: 'ArrowRight' });
    await waitFor(() => expect(bridge.setMode).toHaveBeenCalledWith('auto-apply'));
  });
});

describe('App shell', () => {
  it('navigates between pages, from the nav and from the menu', async () => {
    const t = installBridge(makeState(), [entry({ id: '1', opId: 'op-1' })]);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Project' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activity' }).getAttribute('aria-current')).toBe(
      'page'
    );
    act(() => t.menu('settings'));
    expect(screen.getByRole('heading', { name: 'Backups' })).toBeTruthy();
  });

  it('shows Stop on every page while Full auto runs', async () => {
    const running = makeState({
      mode: 'full-auto',
      loop: { loopId: 'l1', state: 'acting', step: 2, limit: 10 }
    });
    const { bridge } = installBridge(running);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Step 2 of 10')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(bridge.stopLoop).toHaveBeenCalled();
  });

  it('says the project is missing, with a way to reopen it', async () => {
    installBridge(makeState({ project: { name: 'app', path: '~/code/app', missing: true } }));
    render(<App />);
    expect(await screen.findByText('Project missing.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('toasts an auto-applied edit that lands while the window is open', async () => {
    const t = installBridge(makeState(), []);
    render(<App />);
    await screen.findByRole('heading', { name: 'Project' });
    act(() =>
      t.pushActivity([entry({ id: 'n1', kind: 'create', path: 'src/new.ts', trigger: 'auto' })])
    );
    const toast = (await screen.findByText('Auto-applied')).closest('.toast') as HTMLElement;
    expect(within(toast).getByText('src/new.ts')).toBeTruthy();
    expect(within(toast).getByText('Undo it in Activity.')).toBeTruthy();
  });

  it('toasts Full auto turning off when a session starts or ends', async () => {
    const t = installBridge(makeState({ mode: 'full-auto' }), []);
    render(<App />);
    await screen.findByRole('heading', { name: 'Project' });
    act(() => t.push(makeState({ mode: 'manual', sessionResets: 1 })));
    const toast = (await screen.findByText('Full auto turned off: it’s per session.')).closest(
      '.toast'
    ) as HTMLElement;
    expect(
      within(toast).getByText('Auto-apply and Manual carry over between sessions.')
    ).toBeTruthy();
  });

  it('copies the pairing code’s digits only, and says Copied for a moment', async () => {
    const t = installBridge(
      makeState({
        paired: false,
        status: 'not-paired',
        pairing: { phase: 'code', code: '160508', expiresAt: Date.now() + 60_000 }
      })
    );
    render(<App />);
    expect(await screen.findByText('160 508')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the pairing code' }));
    expect(t.bridge.copyPairingCode).toHaveBeenCalledWith();
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Copy the pairing code' })).toBeTruthy(),
      {
        timeout: 2_500
      }
    );
  });

  it('shows the fingerprint to compare, and confirms or cancels it', async () => {
    const t = installBridge(
      makeState({
        paired: false,
        status: 'not-paired',
        pairing: {
          phase: 'compare',
          fingerprint: 'a1b2 c3d4',
          expiresAt: Date.now() + 60_000,
          confirmed: false
        }
      })
    );
    render(<App />);
    expect(await screen.findByLabelText('Fingerprint a 1 b 2 c 3 d 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'They match' }));
    expect(t.bridge.confirmPairing).toHaveBeenCalled();
    act(() =>
      t.push(
        makeState({
          paired: false,
          status: 'not-paired',
          pairing: {
            phase: 'compare',
            fingerprint: 'a1b2 c3d4',
            expiresAt: Date.now() + 60_000,
            confirmed: true
          }
        })
      )
    );
    expect(await screen.findByText(/Now confirm it in the side panel/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'They match' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(t.bridge.cancelPairing).toHaveBeenCalled();
  });
});

describe('Protocol mismatch', () => {
  it.each([
    ['update-app', 'Update the Bridge app', /newer than this app/],
    ['update-extension', 'Update the extension', /older than this app/]
  ] as const)(
    '%s: says which side to update, in the header and on both pages',
    async (status, label, hint) => {
      installBridge(makeState({ status, paired: false }));
      render(<App />);
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
      expect(screen.getByText(hint)).toBeTruthy();
      cleanup();
      render(<SettingsView state={makeState({ status, paired: false })} />);
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByText(hint)).toBeTruthy();
    }
  );
});

describe('Settings → About', () => {
  it('shows the version, checks on a click, and links a newer release', async () => {
    const { bridge } = installBridge();
    const { rerender } = render(<SettingsView state={makeState()} />);
    expect(screen.getByText('Bridge 1.0.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1);

    const about = (update: DesktopState['about']['update']) =>
      makeState({ about: { ...makeState().about, update } });
    rerender(<SettingsView state={about({ state: 'checking' })} />);
    expect(
      (screen.getByRole('button', { name: 'Check for updates' }) as HTMLButtonElement).disabled
    ).toBe(true);
    rerender(<SettingsView state={about({ state: 'current', version: '1.0.0', checkedAt: 1 })} />);
    expect(screen.getByText('You have the latest version.')).toBeTruthy();
    const url = 'https://github.com/jpsoriaga/bridge/releases/tag/v1.1.0';
    rerender(
      <SettingsView state={about({ state: 'available', version: '1.1.0', url, checkedAt: 2 })} />
    );
    expect(screen.getByText(/Bridge 1\.1\.0 is available/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'View the release' }) as HTMLAnchorElement;
    expect([link.href, link.target]).toEqual([url, '_blank']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Check for updates when Bridge starts' }));
    expect(bridge.setCheckUpdatesOnStart).toHaveBeenCalledWith(true);
  });

  it('has no check in builds that never look, only the Releases page', () => {
    installBridge();
    render(
      <SettingsView
        state={makeState({
          about: { ...makeState().about, update: { state: 'off', reason: 'unsigned-mac' } }
        })}
      />
    );
    expect(screen.getByText(/off in unsigned macOS builds/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Releases page' })).toBeTruthy();
    // No channel to pick without checks, but diagnostics still work.
    expect(screen.queryByRole('radiogroup', { name: 'Update channel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeTruthy();
  });

  it('switches the update channel, and says which one this build starts on', () => {
    const { bridge } = installBridge();
    const beta = (channel: 'stable' | 'beta') =>
      makeState({
        about: {
          ...makeState().about,
          version: '1.2.0-beta.1',
          channel,
          defaultChannel: 'beta'
        }
      });
    const { rerender } = render(<SettingsView state={beta('beta')} />);
    expect(screen.getByText('Bridge 1.2.0-beta.1')).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: 'Update channel' });
    const option = (name: string) => within(group).getByRole('radio', { name });
    expect(option('Beta').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/new betas for testers too/)).toBeTruthy();
    fireEvent.click(option('Stable'));
    expect(bridge.setUpdateChannel).toHaveBeenCalledWith('stable');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(bridge.setUpdateChannel).toHaveBeenLastCalledWith('stable');

    rerender(<SettingsView state={beta('stable')} />);
    expect(screen.getByText(/new releases only\. This build starts on Beta\./)).toBeTruthy();
  });

  it('copies diagnostics and opens the logs folder', () => {
    const { bridge } = installBridge();
    render(<SettingsView state={makeState()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    expect(bridge.copyDiagnostics).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));
    expect(bridge.openLogsFolder).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Never file contents, keys or tokens/)).toBeTruthy();
  });

  it('toasts when diagnostics are copied, from the menu or the button', () => {
    const before = makeState();
    const after = makeState({ about: { ...before.about, diagnosticsCopied: 1 } });
    const toasts = toastsFor({ state: before, entries: [] }, { state: after, entries: [] });
    expect(toasts.map((t) => t.text)).toEqual(['Diagnostics copied']);
  });

  it('toasts a newer version once', () => {
    const before = makeState();
    const after = makeState({
      about: {
        ...before.about,
        update: { state: 'available', version: '1.1.0', url: 'https://x', checkedAt: 1 },
        checkOnStart: true
      }
    });
    const toasts = toastsFor({ state: before, entries: [] }, { state: after, entries: [] });
    expect(toasts.map((t) => t.text)).toEqual(['Bridge 1.1.0 is available']);
    expect(toastsFor({ state: after, entries: [] }, { state: after, entries: [] })).toEqual([]);
  });
});

describe('1.3.0: background processes', () => {
  it('marks dev-server suggestions as background, and lets each entry be one or the other', () => {
    const { bridge } = installBridge();
    const { unmount } = render(
      <SettingsView
        state={makeState({
          allowlist: null,
          allowlistSuggestions: ['npm test', 'npm run dev'],
          background: ['npm run dev']
        })}
      />
    );
    const dev = screen.getByRole('checkbox', { name: /npm run dev/ }).closest('label')!;
    expect(within(dev).getByText('background')).toBeTruthy();
    expect(screen.getByText(/keep running between messages/)).toBeTruthy();
    unmount();

    render(
      <SettingsView
        state={makeState({ allowlist: ['npm test', 'npm run dev'], background: ['npm run dev'] })}
      />
    );
    const devBox = screen.getByRole('checkbox', { name: 'Run npm run dev in the background' });
    expect((devBox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(devBox);
    expect(bridge.setBackgroundEntries).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Run npm test in the background' }));
    expect(bridge.setBackgroundEntries).toHaveBeenLastCalledWith(['npm run dev', 'npm test']);
  });

  it('shows each process with its URL, uptime, Stop and logs', async () => {
    const { bridge } = installBridge(
      makeState({
        processes: [
          {
            procId: 'p-1',
            command: 'npm run dev',
            state: 'running',
            url: 'http://localhost:5173/',
            startedAt: Date.now() - 65_000,
            endedAt: null,
            exitCode: null,
            signal: null
          },
          {
            procId: 'p-2',
            command: 'npm run api',
            state: 'exited',
            url: null,
            startedAt: Date.now() - 5_000,
            endedAt: Date.now(),
            exitCode: 1,
            signal: null
          }
        ]
      })
    );
    bridge.getProcessLogs.mockResolvedValue({
      procId: 'p-1',
      command: 'npm run dev',
      lines: ['VITE v5 ready in 312 ms', '➜  Local: http://localhost:5173/'],
      first: 0,
      next: 2
    });
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Background processes' })).closest(
      'section'
    )!;
    expect(within(section).getByText(/Running · 1m \d+s/)).toBeTruthy();
    expect(within(section).getByText('Exited (exit 1)')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'http://localhost:5173/' }));
    expect(bridge.openProcessUrl).toHaveBeenCalledWith('p-1');
    fireEvent.click(within(section).getAllByRole('button', { name: 'View logs' })[0]!);
    expect(await within(section).findByText(/VITE v5 ready/)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Stop' }));
    expect(bridge.stopProcess).toHaveBeenCalledWith('p-1');
  });
});

describe('exit colours', () => {
  const ended = (
    procId: string,
    command: string,
    exitCode: number | null,
    signal: string | null = null
  ) => ({
    procId,
    command,
    state: 'exited' as const,
    url: null,
    startedAt: Date.now() - 5_000,
    endedAt: Date.now(),
    exitCode,
    signal
  });

  it('shows a clean exit neutral and a failed or killed one red on the Session page', async () => {
    installBridge(
      makeState({
        processes: [
          ended('p-1', 'npm run build:watch', 0),
          ended('p-2', 'npm run api', 1),
          ended('p-3', 'npm run dev', null, 'SIGKILL')
        ]
      })
    );
    render(<App />);
    const section = (await screen.findByRole('heading', { name: 'Background processes' })).closest(
      'section'
    )!;
    const tone = (command: string) =>
      within(section)
        .getByText(command)
        .closest('li')!
        .querySelector('.dot')!
        .getAttribute('data-tone');
    expect(tone('npm run build:watch')).toBeNull();
    expect(tone('npm run api')).toBe('danger');
    expect(tone('npm run dev')).toBe('danger');
  });

  it('shows exit 0 neutral and other exits red in Activity', () => {
    installBridge();
    render(
      <ActivityView
        hasProject
        entries={[
          entry({ id: 'a', kind: 'process', path: 'npm run once', text: 'exited (exit 0)' }),
          entry({ id: 'b', kind: 'process', path: 'npm run api', text: 'exited (exit 1)' }),
          entry({ id: 'c', kind: 'process', path: 'npm run dev', text: 'exited (SIGKILL)' }),
          entry({
            id: 'd',
            kind: 'run',
            path: 'npm test',
            run: { status: 'exited', exitCode: 0, durationMs: 900 }
          })
        ]}
      />
    );
    const tone = (text: RegExp) =>
      screen
        .getByText(text)
        .closest('li, button')!
        .querySelector('.dot')
        ?.getAttribute('data-tone') ?? null;
    expect(tone(/Background · exited \(exit 0\)/)).toBeNull();
    expect(tone(/Background · exited \(exit 1\)/)).toBe('danger');
    expect(tone(/Background · exited \(SIGKILL\)/)).toBe('danger');
    expect(tone(/Passed · 0\.9s/)).toBe('success');
  });
});

describe('1.3.0: Full auto settings', () => {
  it('switches to Unlimited, explains it once, and goes back to a limit', () => {
    const { bridge } = installBridge();
    const { rerender } = render(<SettingsView state={makeState()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unlimited' }));
    expect(bridge.setRunSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ stepLimit: null })
    );
    const unlimited = makeState({
      runSettings: { ...makeState().runSettings, stepLimit: null }
    });
    rerender(<SettingsView state={unlimited} />);
    expect(screen.getByText(/each step uses one of your messages/)).toBeTruthy();
    expect(
      (screen.getByRole('spinbutton', { name: /Step limit/ }) as HTMLInputElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(bridge.dismissUnlimitedNote).toHaveBeenCalled();
    rerender(<SettingsView state={{ ...unlimited, unlimitedNoteSeen: true }} />);
    expect(screen.queryByText(/each step uses one of your messages/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Unlimited' }));
    expect(bridge.setRunSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ stepLimit: 25 })
    );
  });

  it('turns each “Also approve automatically” on through the app, and says the risk when on', () => {
    const { bridge } = installBridge();
    const { rerender } = render(<SettingsView state={makeState()} />);
    const deletes = screen.getByRole('checkbox', { name: 'Deletes and renames' });
    expect((deletes as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/deletes and moves files the chat names/)).toBeNull();
    fireEvent.click(deletes);
    expect(bridge.setAutoApprove).toHaveBeenLastCalledWith({
      changes: true,
      gated: false,
      partial: false
    });
    rerender(
      <SettingsView
        state={makeState({ autoApprove: { changes: true, gated: true, partial: false } })}
      />
    );
    expect(screen.getByText(/deletes and moves files the chat names/)).toBeTruthy();
    expect(screen.getByText(/decide what install, build and test commands run/)).toBeTruthy();
    expect(screen.getByText(/marks everything Full auto approved this way/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Partial-looking files' }));
    expect(bridge.setAutoApprove).toHaveBeenLastCalledWith({
      changes: true,
      gated: true,
      partial: true
    });
  });
});

describe('1.3.0: Activity', () => {
  it('labels automatic approvals, downloads and background processes', () => {
    installBridge();
    render(
      <ActivityView
        hasProject
        entries={[
          entry({
            id: 'a',
            kind: 'delete',
            path: 'old.ts',
            trigger: 'auto',
            autoApproved: true,
            opId: 'op-a'
          }),
          entry({
            id: 'b',
            kind: 'create',
            path: 'logo.svg',
            origin: 'download',
            binary: true,
            source: 'chat',
            opId: 'op-b'
          }),
          entry({ id: 'c', kind: 'process', path: 'npm run dev', text: 'started' })
        ]}
      />
    );
    expect(screen.getByText(/auto-approved/)).toBeTruthy();
    expect(screen.getByText(/downloaded · via chat/)).toBeTruthy();
    expect(screen.getByText(/Background · started/)).toBeTruthy();
    expect(kindsOf(entry({ id: 'd', kind: 'process' }))).toContain('run');
  });

  it('shows a thumbnail of an image Bridge wrote', async () => {
    const { bridge } = installBridge();
    bridge.getOpDetail.mockResolvedValue({
      opId: 'op-b',
      kind: 'create',
      path: 'public/hero.png',
      time: Date.now(),
      undone: false,
      before: null,
      after: null,
      unavailable: 'binary',
      image: { mime: 'image/png', after: 'iVBORw0K', before: null }
    });
    render(
      <ActivityView
        hasProject
        entries={[
          entry({ id: 'b', kind: 'create', path: 'public/hero.png', binary: true, opId: 'op-b' })
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /public\/hero.png/ }));
    const img = await screen.findByRole('img', { name: 'public/hero.png as Bridge wrote it' });
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0K');
  });
});
