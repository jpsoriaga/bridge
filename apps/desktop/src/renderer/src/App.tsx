import { useEffect, useState } from 'react';
import {
  CONNECTION_STATUS_TONES,
  DEFAULT_PORT,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  MODES,
  PORT_RANGE,
  type ConnectionStatus,
  type Mode
} from '@bridge/shared';
import type { DesktopState } from '../../preload/api';
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
  const status = state?.status ?? 'connecting';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span>Bridge</span>
        </div>
        <span className="status" role="status">
          <span className="dot" data-tone={CONNECTION_STATUS_TONES[status]} />
          {state ? STATUS_LABELS[status] : 'Starting…'}
        </span>
      </header>

      <main className="panel">
        {state && <ExtensionSection state={state} />}

        <section>
          <p className="label">Project</p>
          <p className="value">No project selected</p>
        </section>

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
        </section>
      </main>

      <footer className="footer">v{window.bridge.version}</footer>
    </div>
  );
}
