import { useEffect, useState, type FormEvent } from 'react';
import {
  CONNECTION_STATUS_TONES,
  DEFAULT_PORT,
  FILE_ERROR_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  MODES,
  PORT_RANGE,
  type ConnectionStatus,
  type Mode
} from '@bridge/shared';
import type { ActivityEntry, DesktopState, OpenFolderResult, UndoOutcome } from '../../preload/api';
import { Logo } from './Logo';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  'app-not-running': 'Not running',
  'not-paired': 'Not paired',
  connecting: 'Waiting for extension',
  connected: 'Connected',
  error: 'Server error'
};

/** Re-renders every second while `active`, for countdowns. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [active]);
  return now;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function useDesktopState(): DesktopState | null {
  const [state, setState] = useState<DesktopState | null>(null);
  useEffect(() => {
    const unsubscribe = window.bridge.onStatus(setState);
    void window.bridge.getStatus().then(setState);
    return unsubscribe;
  }, []);
  return state;
}

function useActivity(): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    const unsubscribe = window.bridge.onActivity(setEntries);
    void window.bridge.getActivity().then(setEntries);
    return unsubscribe;
  }, []);
  return entries;
}

const OPEN_ERRORS: Record<Exclude<OpenFolderResult, { ok: true }>['reason'], string | null> = {
  cancelled: null,
  'not-a-directory': 'That folder can’t be opened. It may have been moved or deleted.',
  'too-broad': 'Choose a project folder, not your home folder or the top of a disk.',
  protected: 'That folder holds Bridge’s own data. Choose a different one.'
};

function ProjectSection({ state }: { state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { project, recentProjects } = state;

  const run = (action: () => Promise<OpenFolderResult>) => {
    setBusy(true);
    setError(null);
    void action()
      .then((result) => setError(result.ok ? null : OPEN_ERRORS[result.reason]))
      .finally(() => setBusy(false));
  };

  // The current project is always first in the recent list; show the others.
  const others = recentProjects
    .map((recent, index) => ({ ...recent, index }))
    .filter((recent) => recent.path !== project?.path);

  return (
    <section>
      <p className="label">Project</p>
      {project ? (
        <>
          <p className="value">{project.name}</p>
          <p className="hint mono project-path" title={project.path}>
            {project.path}
          </p>
        </>
      ) : (
        <>
          <p className="value">No project open</p>
          <p className="hint">
            Choose the folder the chat may read and edit. Nothing outside it is reachable.
          </p>
        </>
      )}
      <div className="actions">
        <button
          type="button"
          className={project ? 'btn' : 'btn btn-primary btn-lg'}
          disabled={busy}
          onClick={() => run(() => window.bridge.openFolder())}
        >
          {project ? 'Open another folder…' : 'Open folder…'}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {others.length > 0 && (
        <>
          <p className="label recent-label">Recent</p>
          <ul className="recent">
            {others.map((recent) => (
              <li key={recent.path}>
                <button
                  type="button"
                  className="recent-item"
                  disabled={busy}
                  title={recent.path}
                  onClick={() => run(() => window.bridge.openRecent(recent.index))}
                >
                  <span>{recent.name}</span>
                  <span className="mono recent-path">{recent.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const UNDO_ERRORS: Partial<Record<Exclude<UndoOutcome, { ok: true }>['code'], string>> = {
  'already-undone': 'That change was already undone.',
  'unknown-op': 'There’s nothing to undo.',
  'io-error': 'Bridge couldn’t restore the file. Its backup may have been removed.',
  denied: 'That file is protected now, so Bridge won’t change it.',
  'outside-root': 'That path now leads outside the project, so Bridge won’t change it.',
  'not-a-file': 'Something other than a file is at that path now.',
  'no-project': 'Open the project first.'
};

const formatTime = (time: number) =>
  new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function describe(entry: ActivityEntry): { meta: string; tone?: 'success' | 'danger' } {
  const reason = entry.code ? FILE_ERROR_LABELS[entry.code] : '';
  switch (entry.kind) {
    case 'create':
      return entry.undone ? { meta: 'Created · undone' } : { meta: 'Created', tone: 'success' };
    case 'modify':
      return entry.undone ? { meta: 'Modified · undone' } : { meta: 'Modified', tone: 'success' };
    case 'rejected':
      return { meta: `Blocked ${entry.op ?? 'request'} · ${reason}`, tone: 'danger' };
    case 'failed':
      return {
        meta: `${entry.op === 'undo' ? 'Undo' : 'Write'} failed · ${reason}`,
        tone: 'danger'
      };
  }
}

function ActivitySection({
  entries,
  hasProject
}: {
  entries: ActivityEntry[];
  hasProject: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canUndoLast = entries.some((e) => e.opId && !e.undone);

  const run = (action: () => Promise<UndoOutcome>) => {
    setBusy(true);
    setError(null);
    void action()
      .then((outcome) => {
        if (!outcome.ok && outcome.code !== 'cancelled') {
          setError(UNDO_ERRORS[outcome.code] ?? 'Undo failed.');
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <section>
      <div className="section-head">
        <p className="label">Activity</p>
        <button
          type="button"
          className="btn"
          disabled={busy || !canUndoLast}
          onClick={() => run(() => window.bridge.undoLast())}
        >
          Undo last
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="hint">
          {hasProject
            ? 'Files the chat writes, and anything Bridge blocks, show up here.'
            : 'Open a project to see its activity.'}
        </p>
      ) : (
        <ul className="activity activity-scroll">
          {entries.map((entry) => {
            const { meta, tone } = describe(entry);
            return (
              <li key={entry.id} className="activity-row" data-undone={entry.undone === true}>
                <span className="dot" data-tone={tone} />
                <span className="activity-text">
                  <span className="activity-path" title={entry.path}>
                    {entry.path || '(no path)'}
                  </span>
                  <span className="activity-meta">
                    {formatTime(entry.time)} · {meta}
                  </span>
                </span>
                {entry.opId && !entry.undone && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => run(() => window.bridge.undo(entry.opId!))}
                  >
                    Undo
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ProtectedFiles({ state }: { state: DesktopState }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = (patterns: string[]) =>
    window.bridge.setDenyPatterns(patterns).then((ok) => {
      setError(ok ? null : 'Use one .gitignore-style pattern, without "!" or "#".');
      return ok;
    });

  const add = (event: FormEvent) => {
    event.preventDefault();
    const pattern = draft.trim();
    if (!pattern) return;
    void save([...state.denyPatterns, pattern]).then((ok) => ok && setDraft(''));
  };

  return (
    <div className="protected">
      <p className="label">Protected files</p>
      <p className="hint">
        Never read, written or listed:{' '}
        <span className="mono">{state.defaultDenyPatterns.join('  ')}</span>
      </p>
      {state.denyPatterns.length > 0 && (
        <ul className="patterns">
          {state.denyPatterns.map((pattern) => (
            <li key={pattern}>
              <span className="mono">{pattern}</span>
              <button
                type="button"
                className="btn"
                onClick={() => void save(state.denyPatterns.filter((p) => p !== pattern))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="pattern-form" onSubmit={add}>
        <input
          className="input mono"
          placeholder="secrets/ or *.sqlite"
          aria-label="Add a protected pattern"
          aria-invalid={error !== null}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ExtensionSection({ state }: { state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const now = useNow(state.pairing !== null || state.lockedUntil !== null);
  const code = state.pairing && state.pairing.expiresAt > now ? state.pairing : null;
  const lockedFor = state.lockedUntil ? state.lockedUntil - now : 0;

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  const startPairing = () => run(() => window.bridge.startPairing());

  return (
    <section>
      <p className="label">Extension</p>

      {code ? (
        <>
          <p className="pairing-code" aria-label={`Pairing code ${code.code.split('').join(' ')}`}>
            {code.code.slice(0, 3)} {code.code.slice(3)}
          </p>
          <p className="hint">
            Enter this code in the Bridge side panel in Chrome. Expires in{' '}
            {formatCountdown(code.expiresAt - now)}.
          </p>
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={startPairing}>
              New code
            </button>
          </div>
        </>
      ) : state.paired ? (
        <>
          <p className="value">Paired</p>
          <p className="hint">
            {state.status === 'connected'
              ? 'The extension is connected.'
              : 'Waiting for the extension to connect. Open Chrome to reconnect.'}
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => run(() => window.bridge.unpair())}
            >
              Unpair
            </button>
            <button type="button" className="btn" disabled={busy} onClick={startPairing}>
              Pair again
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="value">Not paired</p>
          <p className="hint">
            Pair the Bridge extension in Chrome to let the chat reach this app.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={busy || state.port === null}
              onClick={startPairing}
            >
              Pair extension
            </button>
          </div>
        </>
      )}

      {lockedFor > 0 && (
        <p className="error-text" role="alert">
          Too many wrong codes. Pairing is locked for {Math.max(1, Math.floor(lockedFor / 1000))}s.
          Start a new code after that.
        </p>
      )}
    </section>
  );
}

export function App() {
  const [mode, setMode] = useState<Mode>('manual');
  const state = useDesktopState();
  const activity = useActivity();
  const status = state?.status ?? 'connecting';
  const project = state?.project ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Bridge</span>
        </div>
        {project && (
          <div className="project-head" title={project.path}>
            <span className="project-name">{project.name}</span>
            <span className="mono project-head-path">{project.path}</span>
          </div>
        )}
        <span className="status" role="status">
          <span className="dot" data-tone={CONNECTION_STATUS_TONES[status]} />
          {state ? STATUS_LABELS[status] : 'Starting…'}
        </span>
      </header>

      <main className="panel">
        {state && <ProjectSection state={state} />}

        {state && <ExtensionSection state={state} />}

        <section>
          <p className="label" id="mode-label">
            Mode
          </p>
          <div className="segmented" role="radiogroup" aria-labelledby="mode-label">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={m === mode}
                onClick={() => setMode(m)}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
          <p className="hint">{MODE_DESCRIPTIONS[mode]}</p>
        </section>

        <ActivitySection entries={activity} hasProject={project !== null} />

        <section>
          <p className="label">Settings</p>
          <dl className="settings">
            <dt>Local server</dt>
            <dd className="mono">{state?.port ? `127.0.0.1:${state.port}` : 'Not running'}</dd>
          </dl>
          {state?.status === 'error' && (
            <p className="error-text" role="alert">
              Bridge couldn&apos;t start its local server on ports {DEFAULT_PORT}–
              {DEFAULT_PORT + PORT_RANGE - 1}. Quit whatever is using them and restart Bridge.
            </p>
          )}
          {state && <ProtectedFiles state={state} />}
        </section>
      </main>

      <footer className="footer">v{window.bridge.version}</footer>
    </div>
  );
}
