import { useState, type KeyboardEvent } from 'react';
import { MODE_DESCRIPTIONS, MODE_LABELS, MODES, type Mode } from '@bridge/shared';
import type { ActivityEntry, DesktopState, OpenFolderResult } from '../../preload/api';
import { RunningCommand } from './Commands';
import { EntryMark, EntryMeta, resultOf } from './EntryMark';
import { describeEntry, OPEN_ERRORS } from './errors';
import { formatCountdown, formatTime, useNow } from './hooks';
import { LoopStatus } from './Loop';
import { Onboarding, type Step } from './Onboarding';

/** The open project, or what to do without one (or with one that went missing). */
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
  const current = project ? recentProjects.findIndex((r) => r.path === project.path) : -1;

  return (
    <section aria-labelledby="project-title">
      <h2 className="section-title" id="project-title">
        Project
      </h2>
      {project ? (
        <>
          <p className="value">{project.name}</p>
          <p className="hint mono project-path" title={project.path}>
            {project.path}
          </p>
          {project.missing && (
            <div className="notice" role="alert">
              <p>
                <strong>Project missing.</strong> The folder was moved, renamed, deleted or its disk
                was unmounted. Every file request fails until it’s back.
              </p>
              <div className="actions">
                {current !== -1 && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => run(() => window.bridge.openRecent(current))}
                  >
                    Try again
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => run(() => window.bridge.openFolder())}
                >
                  Open folder…
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="value">No project open</p>
          <p className="hint">
            Choose the folder the chat may read and edit. Nothing outside it is reachable.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={busy}
              onClick={() => run(() => window.bridge.openFolder())}
            >
              Open folder…
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Pairing with the Chrome extension: the code, the paired state, or Pair. */
export function ExtensionSection({ state }: { state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const now = useNow(state.pairing !== null || state.lockedUntil !== null);
  const live = state.pairing && state.pairing.expiresAt > now ? state.pairing : null;
  const code = live?.phase === 'code' ? live : null;
  const compare = live?.phase === 'compare' ? live : null;
  const lockedFor = state.lockedUntil ? state.lockedUntil - now : 0;

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  const startPairing = () => run(() => window.bridge.startPairing());

  return (
    <section aria-labelledby="extension-title" id="extension">
      <h2 className="section-title" id="extension-title">
        Extension
      </h2>
      {compare ? (
        <>
          <p className="hint">Check the Bridge side panel in Chrome shows the same fingerprint:</p>
          <p
            className="pairing-code"
            aria-label={`Fingerprint ${compare.fingerprint.replace(' ', '').split('').join(' ')}`}
          >
            {compare.fingerprint}
          </p>
          {compare.confirmed ? (
            <p className="hint" role="status">
              Confirmed here. Now confirm it in the side panel to finish pairing. Expires in{' '}
              {formatCountdown(compare.expiresAt - now)}.
            </p>
          ) : (
            <p className="hint">
              If it’s different, something else answered the extension: cancel and pair again.
              Expires in {formatCountdown(compare.expiresAt - now)}.
            </p>
          )}
          <div className="actions">
            {!compare.confirmed && (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={busy}
                onClick={() => run(() => window.bridge.confirmPairing())}
              >
                They match
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => window.bridge.cancelPairing())}
            >
              Cancel
            </button>
          </div>
        </>
      ) : code ? (
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
      {state.status === 'error' && (
        <p className="error-text" role="alert">
          Bridge couldn’t start its local server. Quit whatever is using ports 47821–47830, then
          restart Bridge.
        </p>
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

/**
 * The mode switch. Choosing Full auto asks in a native dialog first (main shows it; this
 * page can't skip it), so the switch shows whatever mode main says it ended up in.
 */
export function ModeSection({ state }: { state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Mode | null>(null);
  const choose = (mode: Mode) => {
    if (mode === state.mode || busy) return;
    setBusy(true);
    setPending(mode);
    void window.bridge.setMode(mode).finally(() => {
      setBusy(false);
      setPending(null);
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const at = MODES.indexOf(state.mode);
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    choose(MODES[(at + step + MODES.length) % MODES.length]!);
  };
  return (
    <section aria-labelledby="mode-title" id="mode">
      <h2 className="section-title" id="mode-title">
        Mode
      </h2>
      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="mode-title"
        onKeyDown={onKeyDown}
      >
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={m === state.mode}
            tabIndex={m === state.mode ? 0 : -1}
            disabled={busy && m !== state.mode}
            onClick={() => choose(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <p className="hint" aria-live="polite">
        {pending === 'full-auto'
          ? 'Confirm in the dialog to turn on Full auto.'
          : MODE_DESCRIPTIONS[state.mode]}
      </p>
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

/** The last few activity rows, with a link to the rest. */
function RecentActivity({
  entries,
  onShowAll
}: {
  entries: ActivityEntry[] | null;
  onShowAll: () => void;
}) {
  const recent = (entries ?? []).filter((e) => e.kind !== 'loop').slice(0, 5);
  return (
    <section aria-labelledby="recent-title">
      <div className="section-head">
        <h2 className="section-title" id="recent-title">
          Recent activity
        </h2>
        <button type="button" className="link-button" onClick={onShowAll}>
          View all
        </button>
      </div>
      {entries === null ? (
        <div className="skeleton-group" aria-busy="true" aria-label="Loading activity">
          <span className="skeleton" />
          <span className="skeleton short" />
        </div>
      ) : recent.length === 0 ? (
        <p className="empty">
          Nothing yet. Edits the chat applies, and anything Bridge blocks, show up here.
        </p>
      ) : (
        <ul className="activity">
          {recent.map((entry) => {
            const description = describeEntry(entry);
            return (
              <li
                key={entry.id}
                className="activity-row"
                data-undone={entry.undone === true}
                data-result={resultOf(entry, description)}
              >
                <EntryMark description={description} />
                <span className="activity-text">
                  <span className="activity-path" title={entry.path}>
                    {entry.path || '(no path)'}
                  </span>
                  <span className="activity-meta">
                    <EntryMeta description={description} time={formatTime(entry.time)} />
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SessionView({
  state,
  entries,
  showOnboarding,
  onStep,
  onShowActivity
}: {
  state: DesktopState;
  entries: ActivityEntry[] | null;
  showOnboarding: boolean;
  onStep: (step: Step['id']) => void;
  onShowActivity: () => void;
}) {
  return (
    <>
      {showOnboarding && <Onboarding state={state} onGo={onStep} />}
      <ProjectSection state={state} />
      <ExtensionSection state={state} />
      <ModeSection state={state} />
      <RunningCommand state={state} />
      <RecentActivity entries={entries} onShowAll={onShowActivity} />
    </>
  );
}
