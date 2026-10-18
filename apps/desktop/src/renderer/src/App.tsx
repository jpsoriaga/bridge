import { useCallback, useEffect, useRef, useState } from 'react';
import type { MenuAction, Theme } from '../../preload/api';
import { ActivityView } from './ActivityView';
import { Header } from './Header';
import { useActivity, useDesktopState } from './hooks';
import { Icon, type IconName } from './Icon';
import { LoopStrip, Toasts } from './Loop';
import type { Step } from './Onboarding';
import { SessionView } from './SessionView';
import { SettingsView, showSection } from './SettingsView';

export type View = 'session' | 'activity' | 'settings';

const VIEWS: { id: View; label: string; icon: IconName }[] = [
  { id: 'session', label: 'Session', icon: 'session' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
];

/** Puts the Appearance setting on <html>, where the tokens' color-scheme reads it. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Placeholder rows until the first state arrives from main. */
function Loading() {
  return (
    <div className="skeleton-group" aria-busy="true" aria-label="Loading">
      <span className="skeleton short" />
      <span className="skeleton" />
      <span className="skeleton" />
      <span className="skeleton short" />
    </div>
  );
}

function Nav({
  view,
  onView,
  onHelp
}: {
  view: View;
  onView: (view: View) => void;
  onHelp: () => void;
}) {
  return (
    <nav className="nav" aria-label="Main">
      <ul className="nav-list">
        {VIEWS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="nav-item"
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => onView(item.id)}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          </li>
        ))}
      </ul>
      <div className="nav-foot">
        <button type="button" className="nav-item" onClick={onHelp}>
          <Icon name="help" />
          Getting started
        </button>
        <p className="version">Bridge {window.bridge.version}</p>
      </div>
    </nav>
  );
}

export function App() {
  const state = useDesktopState();
  const activity = useActivity();
  const [view, setView] = useState<View>('session');
  const [openError, setOpenError] = useState<string | null>(null);
  const main = useRef<HTMLElement>(null);

  const theme = state?.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  const go = useCallback((next: View, then?: () => void) => {
    setView(next);
    // Each page starts at its top; they share one scrolling area.
    if (main.current) main.current.scrollTop = 0;
    // After the page renders: move focus to it, or to where `then` puts it.
    requestAnimationFrame(() => {
      if (then) then();
      else main.current?.focus();
    });
  }, []);

  const showOnboarding = () => {
    void window.bridge.setOnboardingDismissed(false);
    go('session');
  };

  useEffect(
    () =>
      window.bridge.onMenu((action: MenuAction) => {
        if (action === 'onboarding') {
          void window.bridge.setOnboardingDismissed(false);
          go('session');
        } else go(action);
      }),
    [go]
  );

  const onStep = (step: Step['id']) => {
    if (step === 'pair') void window.bridge.startPairing();
    else if (step === 'project') void window.bridge.openFolder();
    else if (step === 'commands') go('settings', () => showSection('commands'));
  };

  return (
    <div className="shell">
      <Header
        state={state}
        onOpenError={setOpenError}
        onShowMode={() => go('session', () => document.getElementById('mode-title')?.focus())}
      />
      <LoopStrip loop={state?.loop ?? null} />
      <div className="body">
        <Nav view={view} onView={(next) => go(next)} onHelp={showOnboarding} />
        <main
          className="page"
          ref={main}
          tabIndex={-1}
          aria-label={VIEWS.find((v) => v.id === view)?.label}
        >
          <div className="column">
            {openError && (
              <p className="error-text" role="alert">
                {openError}
              </p>
            )}
            {!state ? (
              <Loading />
            ) : view === 'session' ? (
              <SessionView
                state={state}
                entries={activity}
                showOnboarding={!state.onboarding.dismissed}
                onStep={onStep}
                onShowActivity={() => go('activity')}
              />
            ) : view === 'activity' ? (
              <ActivityView entries={activity} hasProject={state.project !== null} />
            ) : (
              <SettingsView state={state} />
            )}
          </div>
        </main>
      </div>
      <Toasts state={state} entries={activity} />
    </div>
  );
}
