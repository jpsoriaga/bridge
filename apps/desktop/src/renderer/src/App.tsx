import { useEffect, useState } from 'react';
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
import { CommandsSection, PathOverride, RunningCommand } from './Commands';
import { Logo } from './Logo';
import { AutoToast, LoopBar, LoopStatus } from './Loop';
import { PatternList } from './PatternList';

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
  const via = entry.trigger === 'auto' ? ' · auto' : entry.source === 'chat' ? ' · via chat' : '';
  switch (entry.kind) {
    case 'create':
      return entry.undone
        ? { meta: `Created${via} · undone` }
        : { meta: `Created${via}`, tone: 'success' };
    case 'modify':
      return entry.undone
        ? { meta: `Modified${via} · undone` }
        : { meta: `Modified${via}`, tone: 'success' };
    case 'rejected':
      return { meta: `Blocked ${entry.op ?? 'request'} · ${reason}`, tone: 'danger' };
    case 'failed':
      if (entry.code === 'gated' || entry.code === 'mode') {
        return { meta: `Left for a click · ${reason}` };
      }
      return {
        meta: `${entry.op === 'undo' ? 'Undo' : entry.op === 'run' ? 'Command refused' : 'Write'}${entry.op === 'run' ? '' : ' failed'} · ${reason}`,
        tone: 'danger'
      };
    case 'run': {
      const run = entry.run;
      const seconds = run ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : '';
      if (!run) return { meta: `Ran${via}` };
      if (run.status === 'exited') {
        return run.exitCode === 0
          ? { meta: `Passed${seconds}${via}`, tone: 'success' }
          : { meta: `Exit ${run.exitCode ?? '?'}${seconds}${via}`, tone: 'danger' };
      }
      return {
        meta: `${run.status === 'timed-out' ? 'Timed out' : run.status === 'cancelled' ? 'Cancelled' : 'Couldn’t start'}${seconds}${via}`,
        tone: run.status === 'cancelled' ? undefined : 'danger'
      };
    }
    case 'loop':
      return { meta: 'Full auto' };
  }
}

/** Activity rows, with each Full auto run's rows gathered under its newest one. */
type ActivityItem =
  | { kind: 'row'; entry: ActivityEntry }
  | { kind: 'loop'; loopId: string; entries: ActivityEntry[] };

export function groupActivity(entries: readonly ActivityEntry[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const groups = new Map<string, Extract<ActivityItem, { kind: 'loop' }>>();
  for (const entry of entries) {
    if (!entry.loopId) {
      items.push({ kind: 'row', entry });
      continue;
    }
    let group = groups.get(entry.loopId);
    if (!group) {
      group = { kind: 'loop', loopId: entry.loopId, entries: [] };
      groups.set(entry.loopId, group);
      items.push(group);
    }
    group.entries.push(entry);
  }
  return items;
}

function ActivityRow({
  entry,
  busy,
  run
}: {
  entry: ActivityEntry;
  busy: boolean;
  run: (action: () => Promise<UndoOutcome>) => void;
}) {
  const { meta, tone } = describe(entry);
  const title = entry.kind === 'loop' ? (entry.text ?? '') : entry.path || '(no path)';
  return (
    <li className="activity-row" data-undone={entry.undone === true}>
      <span className="dot" data-tone={tone} />
      <span className="activity-text">
        <span className={entry.kind === 'loop' ? 'activity-note' : 'activity-path'} title={title}>
          {title}
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
          {groupActivity(entries).map((item) =>
            item.kind === 'row' ? (
              <ActivityRow key={item.entry.id} entry={item.entry} busy={busy} run={run} />
            ) : (
              <li key={item.loopId} className="activity-group">
                <p className="activity-group-head">
                  Full auto run ·{' '}
                  {
                    item.entries.filter((e) => e.kind === 'loop' && e.text?.startsWith('Sent'))
                      .length
                  }{' '}
                  messages sent
                </p>
                <ul className="activity">
                  {item.entries.map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} busy={busy} run={run} />
                  ))}
                </ul>
              </li>
            )
          )}
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

function ModeSection({ state }: { state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const choose = (mode: Mode) => {
    if (mode === state.mode) return;
    setBusy(true);
    // Full auto asks for confirmation in a native dialog first.
    void window.bridge.setMode(mode).finally(() => setBusy(false));
  };
  return (
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
            aria-checked={m === state.mode}
            disabled={busy}
            onClick={() => choose(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <p className="hint">{MODE_DESCRIPTIONS[state.mode]}</p>
      {state.mode === 'full-auto' && (
        <p className="hint" data-tone="warning">
          Full auto sends messages for you and runs commands the model may have written. It turns
          off when you restart Bridge, end the session, unpair or switch projects.
        </p>
      )}
      <LoopStatus state={state} />
    </section>
  );
}

export function App() {
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

        {state && <ModeSection state={state} />}

        {state && <RunningCommand state={state} />}

        <ActivitySection entries={activity} hasProject={project !== null} />

        {state && <CommandsSection state={state} />}

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
          {state && (
            <>
              <PatternList
                label="Protected files"
                hint="Never read, written or listed:"
                defaults={state.defaultDenyPatterns}
                patterns={state.denyPatterns}
                placeholder="secrets/ or *.sqlite"
                invalidText="Use one .gitignore-style pattern, without “!” or “#”."
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
                invalidText="Use one .gitignore-style pattern, without “!” or “#”."
                save={(patterns) => window.bridge.setGatedPatterns(patterns)}
              />
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
            </>
          )}
        </section>
      </main>

      <div className="bottom">
        {state && <AutoToast entries={activity} />}
        {state && <LoopBar loop={state.loop} />}
        <footer className="footer">v{window.bridge.version}</footer>
      </div>
    </div>
  );
}
