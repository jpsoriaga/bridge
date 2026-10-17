import { useEffect, useState, type FormEvent } from 'react';
import {
  CONNECTION_STATUS_TONES,
  PAIRING_CODE_LENGTH,
  type ConnectionStatus,
  type ProjectInfo
} from '@bridge/shared';
import {
  SIDE_PANEL_PORT,
  type ChatPanelState,
  type PairResult,
  type PanelHello,
  type StatusUpdate,
  type WorkerRequest
} from '../messages';
import { DevFileTester } from './DevFileTester';
import { Logo } from './Logo';
import { panelWindowId, request } from './request';
import { SessionSection } from './SessionSection';

const NO_CHAT: ChatPanelState = { tab: null, session: null };

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  'app-not-running': 'App not running',
  'not-paired': 'Not paired',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: "Can't reach Bridge"
};

function useWorkerStatus(): StatusUpdate | null {
  const [update, setUpdate] = useState<StatusUpdate | null>(null);
  useEffect(() => {
    const port = chrome.runtime.connect({ name: SIDE_PANEL_PORT });
    port.onMessage.addListener((message: StatusUpdate) => setUpdate(message));
    void panelWindowId().then((windowId) =>
      port.postMessage({ type: 'panel-window', windowId } satisfies PanelHello)
    );
    return () => port.disconnect();
  }, []);
  return update;
}

function pairError(result: Exclude<PairResult, { ok: true }>): string {
  switch (result.error) {
    case 'invalid_code':
      return 'That code didn’t match. Check the Bridge app and try again.';
    case 'locked':
      return `Too many wrong codes. Wait ${Math.ceil(result.retryAfterMs / 1000)}s, then start a new code in the Bridge app.`;
    case 'app-not-running':
      return 'The Bridge app isn’t running. Open it and try again.';
    case 'failed':
      return 'Pairing failed. Try again.';
  }
}

function PairForm() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== PAIRING_CODE_LENGTH) return;
    setBusy(true);
    setError(null);
    void request<PairResult>({ type: 'pair', code })
      .then((result) => {
        if (!result.ok) setError(pairError(result));
        setCode('');
      })
      .catch(() => setError('Pairing failed. Try again.'))
      .finally(() => setBusy(false));
  };

  return (
    <form className="pair-form" onSubmit={submit}>
      <label className="label" htmlFor="pair-code">
        Pairing code
      </label>
      <p className="hint">In the Bridge app, click Pair extension and enter the 6-digit code.</p>
      <div className="pair-row">
        <input
          id="pair-code"
          className="input mono"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          maxLength={PAIRING_CODE_LENGTH}
          value={code}
          aria-invalid={error !== null}
          aria-describedby={error ? 'pair-error' : undefined}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH))}
        />
        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={busy || code.length !== PAIRING_CODE_LENGTH}
        >
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
      {error && (
        <p id="pair-error" className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function ProjectSection({ project }: { project: ProjectInfo | null }) {
  return (
    <section>
      <p className="label">Project</p>
      {project ? (
        <>
          <p className="value">{project.name}</p>
          <p className="hint mono path" title={project.path}>
            {project.path}
          </p>
        </>
      ) : (
        <>
          <p className="value">No project open</p>
          <p className="hint">Open a project folder in the Bridge app.</p>
        </>
      )}
    </section>
  );
}

function Body({
  status,
  project,
  chat
}: {
  status: ConnectionStatus;
  project: ProjectInfo | null;
  chat: ChatPanelState;
}) {
  const [busy, setBusy] = useState(false);
  const act = (message: WorkerRequest) => {
    setBusy(true);
    void request(message).finally(() => setBusy(false));
  };

  switch (status) {
    case 'not-paired':
      return <PairForm />;
    case 'connected':
      return (
        <>
          <ProjectSection project={project} />
          <SessionSection chat={chat} project={project} />
          {import.meta.env.DEV && <DevFileTester />}
          <section>
            <p className="label">Desktop app</p>
            <p className="value">Paired and connected.</p>
            <button
              type="button"
              className="btn btn-danger action"
              disabled={busy}
              onClick={() => act({ type: 'unpair' })}
            >
              Unpair
            </button>
          </section>
        </>
      );
    case 'connecting':
      return (
        <section>
          <p className="label">Desktop app</p>
          <p className="value">Connecting to the Bridge app…</p>
        </section>
      );
    case 'app-not-running':
    case 'error':
      return (
        <section>
          <p className="label">Desktop app</p>
          <p className="value">
            {status === 'error'
              ? 'The Bridge app refused the connection.'
              : 'Open the Bridge app on this computer to connect.'}
          </p>
          <p className="hint">
            {status === 'error'
              ? 'If you unpaired in the app, unpair here too and pair again.'
              : 'Bridge keeps trying in the background.'}
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => act({ type: 'retry' })}
            >
              Try again
            </button>
            {status === 'error' && (
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => act({ type: 'unpair' })}
              >
                Unpair
              </button>
            )}
          </div>
        </section>
      );
  }
}

export function App() {
  const update = useWorkerStatus();
  const status = update?.status ?? null;

  return (
    <div className="panel">
      <header className="panel-header">
        <div className="brand">
          <Logo />
          <span>Bridge</span>
        </div>
        <span className="status" role="status">
          <span className="dot" data-tone={status ? CONNECTION_STATUS_TONES[status] : undefined} />
          {status ? STATUS_LABELS[status] : 'Checking…'}
        </span>
      </header>

      <main className="panel-body">
        {update && (
          <Body
            status={update.status}
            project={update.project}
            // A worker from an older build sends no chat state. Show "no chat" instead of crashing.
            chat={update.chat ?? NO_CHAT}
          />
        )}
      </main>
    </div>
  );
}
