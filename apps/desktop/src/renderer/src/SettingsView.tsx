import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DesktopState, Theme } from '../../preload/api';
import { AllowlistEditor, FullAutoFields, PathOverride, TimeoutField } from './Commands';
import { STATUS_LABELS } from './Header';
import { PatternList } from './PatternList';

export const SETTINGS_SECTIONS = [
  { id: 'connection', title: 'Connection' },
  { id: 'project', title: 'Project' },
  { id: 'commands', title: 'Commands' },
  { id: 'full-auto', title: 'Full auto' },
  { id: 'backups', title: 'Backups' },
  { id: 'appearance', title: 'Appearance' }
] as const;

const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
const PATTERN_HINT = 'Use one .gitignore-style pattern, without “!” or “#”.';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={`settings-${id}`} id={id}>
      <h2 className="section-title" id={`settings-${id}`}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ConnectionSettings({ state }: { state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  return (
    <Section id="connection" title="Connection">
      <dl className="settings">
        <dt>Local server</dt>
        <dd className="mono">{state.port ? `127.0.0.1:${state.port}` : 'Not running'}</dd>
        <dt>Extension</dt>
        <dd>{state.paired ? STATUS_LABELS[state.status] : 'Not paired'}</dd>
      </dl>
      <p className="hint">
        Bridge listens only on this computer, for the paired Bridge extension. Nothing is sent
        anywhere else.
      </p>
      {state.status === 'error' && (
        <p className="error-text" role="alert">
          Bridge couldn’t start its local server on ports 47821–47830. Quit whatever is using them
          and restart Bridge.
        </p>
      )}
      <div className="actions">
        {state.paired ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => run(() => window.bridge.unpair())}
            >
              Unpair
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => window.bridge.startPairing())}
            >
              Pair again
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy || state.port === null}
            onClick={() => run(() => window.bridge.startPairing())}
          >
            Pair extension
          </button>
        )}
      </div>
    </Section>
  );
}

function BackupSettings({ state }: { state: DesktopState }) {
  const [days, setDays] = useState(String(state.backupRetentionDays));
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const save = () => {
    const value = Math.round(Number(days));
    void window.bridge.setBackupRetention(value).then((ok) => {
      setError(ok ? null : 'Keep backups for 1 to 90 days.');
      if (ok) setDays(String(value));
    });
  };
  return (
    <Section id="backups" title="Backups">
      <p className="hint">
        Bridge backs up every file before it writes, deletes or renames it, so each change can be
        undone. Backups live in Bridge’s own folder, never in your project.
      </p>
      <label className="field">
        <span>Keep backups for</span>
        <span className="field-input">
          <input
            className="input mono"
            type="number"
            min={1}
            max={90}
            aria-invalid={error !== null}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <span className="unit">days</span>
        </span>
      </label>
      <p className="hint">Also at most the newest 500 changes per project.</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {state.project ? (
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              void window.bridge.openBackupsFolder().then((ok) => {
                setNote(ok ? null : 'Bridge couldn’t open the backups folder.');
              })
            }
          >
            Open the backups folder
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() =>
              void window.bridge.clearBackups().then((cleared) => {
                setNote(cleared ? `Deleted every backup for ${state.project?.name}.` : null);
              })
            }
          >
            Clear for this project…
          </button>
        </div>
      ) : (
        <p className="empty">Open a project to see or clear its backups.</p>
      )}
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </Section>
  );
}

function AppearanceSettings({ state }: { state: DesktopState }) {
  const choose = (theme: Theme) => void window.bridge.setTheme(theme);
  const onKeyDown = (event: KeyboardEvent) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = THEMES.indexOf(state.theme);
    choose(THEMES[(at + step + THEMES.length) % THEMES.length]!);
  };
  return (
    <Section id="appearance" title="Appearance">
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="settings-appearance"
        onKeyDown={onKeyDown}
      >
        {THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={state.theme === theme}
            tabIndex={state.theme === theme ? 0 : -1}
            onClick={() => choose(theme)}
          >
            {THEME_LABELS[theme]}
          </button>
        ))}
      </div>
      <p className="hint">
        {state.theme === 'system'
          ? 'Follows your computer’s light or dark setting.'
          : `Always ${state.theme}.`}{' '}
        The chat cards follow the chat page’s own theme.
      </p>
    </Section>
  );
}

/** Scrolls to a section and moves focus to its heading. */
export function showSection(id: string): void {
  const heading = document.getElementById(`settings-${id}`);
  if (!heading) return;
  heading.setAttribute('tabindex', '-1');
  heading.scrollIntoView?.({ block: 'start' });
  heading.focus({ preventScroll: true });
}

/** Settings in sections, with an in-page index to jump between them. */
export function SettingsView({ state }: { state: DesktopState }) {
  return (
    <>
      <nav className="settings-index" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className="settings-link"
            onClick={() => showSection(section.id)}
          >
            {section.title}
          </button>
        ))}
      </nav>
      <ConnectionSettings state={state} />
      <Section id="project" title="Project">
        <PatternList
          label="Protected files"
          hint="Never read, written or listed:"
          defaults={state.defaultDenyPatterns}
          patterns={state.denyPatterns}
          placeholder="secrets/ or *.sqlite"
          invalidText={PATTERN_HINT}
          save={(patterns) =>
            window.bridge
              .setDenyPatterns(patterns)
              .then((ok) => (ok ? { ok: true } : { ok: false, invalid: null }))
          }
        />
        <PatternList
          label="Gated files"
          hint="Need a click in every mode, because they can change what commands do. This blocks only the most direct routes: running tests still runs code the chat wrote."
          defaults={state.defaultGatedPatterns}
          patterns={state.gatedPatterns}
          placeholder="vitest.config.* or scripts/"
          invalidText={PATTERN_HINT}
          save={(patterns) => window.bridge.setGatedPatterns(patterns)}
        />
      </Section>
      <Section id="commands" title="Commands">
        <h3 className="subsection-title">Allowed commands</h3>
        <AllowlistEditor state={state} />
        <TimeoutField key={state.runSettings.timeoutMs} settings={state.runSettings} />
        <PatternList
          label="Hidden from commands"
          hint="Environment variables commands never see (* matches anything). CI=1 and FORCE_COLOR=0 are always set."
          defaults={state.defaultEnvPatterns}
          patterns={state.envPatterns}
          placeholder="MY_SERVICE_*"
          invalidText="Use a variable name, with * as a wildcard."
          save={(patterns) => window.bridge.setEnvPatterns(patterns)}
        />
        <PathOverride key={state.commandPath.override} commandPath={state.commandPath} />
      </Section>
      <Section id="full-auto" title="Full auto">
        <FullAutoFields key={state.runSettings.stepLimit} settings={state.runSettings} />
      </Section>
      <BackupSettings key={state.backupRetentionDays} state={state} />
      <AppearanceSettings state={state} />
    </>
  );
}
