import { useEffect, useState, type FormEvent } from 'react';
import {
  CONNECTION_STATUS_TONES,
  PAIRING_CODE_LENGTH,
  type BridgeConfig,
  type ConnectionStatus,
  type ProjectInfo
} from '@bridge/shared';
import {
  SIDE_PANEL_PORT,
  type ChatPanelState,
  type PairConfirmResult,
  type PairResult,
  type PanelHello,
  PanelMessage,
  type StatusUpdate,
  type WorkerRequest
} from '../messages';
import { ContextFiles, Requests } from './ContextFiles';
import { DevFileTester } from './DevFileTester';
import { PageDiagnostics } from './PageDiagnostics';
import {
  appendOutput,
  CommandSection,
  LoopFooter,
  LoopSection,
  ModeSection,
  type LiveRun
} from './FullAuto';
import { Logo } from './Logo';
import { panelWindowId, request } from './request';
import { SendFiles } from './SendFiles';
import { SessionSection } from './SessionSection';

const NO_CHAT: ChatPanelState = { tab: null, session: null, loop: null, requests: [], watch: null };

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  'app-not-running': 'App not running',
  'not-paired': 'Not paired',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: "Can't reach Bridge"
};

function useWorker(): { update: StatusUpdate | null; live: LiveRun | null } {
  const [update, setUpdate] = useState<StatusUpdate | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  useEffect(() => {
    const port = chrome.runtime.connect({ name: SIDE_PANEL_PORT });
    port.onMessage.addListener((raw: unknown) => {
      // Only the worker can reach this port, and its messages are still checked.
      const parsed = PanelMessage.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      switch (message.type) {
        case 'status':
          setUpdate(message);
          break;
        case 'run-output':
          setLive((run) =>
            run?.runId === message.runId && !run.result
              ? { ...run, text: appendOutput(run.text, message.chunk) }
              : { runId: message.runId, text: appendOutput('', message.chunk), result: null }
          );
          break;
        case 'run-exit':
          setLive({
            runId: message.result.runId,
            text: appendOutput('', message.result.output),
            result: message.result
          });
          break;
      }
    });
    void panelWindowId().then((windowId) =>
      port.postMessage({ type: 'panel-window', windowId } satisfies PanelHello)
    );
    return () => port.disconnect();
  }, []);
  return { update, live };
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
  /** The fingerprint to compare with the app's, once the code went through. */
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== PAIRING_CODE_LENGTH) return;
    setBusy(true);
    setError(null);
    void request<PairResult>({ type: 'pair', code })
      .then((result) => {
        if (result.ok) setFingerprint(result.fingerprint);
        else setError(pairError(result));
        setCode('');
      })
      .catch(() => setError('Pairing failed. Try again.'))
      .finally(() => setBusy(false));
  };

  const confirm = () => {
    setBusy(true);
    setError(null);
    void request<PairConfirmResult>({ type: 'pair-confirm' })
      .then((result) => {
        if (result.ok) return;
        if (result.error === 'not-confirmed') {
          setError('Click “They match” in the Bridge app first, then confirm here.');
        } else if (result.error === 'app-not-running') {
          setError('The Bridge app isn’t running. Open it and try again.');
        } else {
          setFingerprint(null);
          setError('This pairing expired or was cancelled. Start a new code in the Bridge app.');
        }
      })
      .catch(() => setError('Pairing failed. Try again.'))
      .finally(() => setBusy(false));
  };

  const cancel = () => {
    setFingerprint(null);
    setError(null);
    void request({ type: 'pair-cancel' });
  };

  if (fingerprint) {
    return (
      <section className="pair-form" aria-labelledby="fingerprint-label">
        <p className="label" id="fingerprint-label">
          Check the fingerprint
        </p>
        <p className="hint">
          The Bridge app shows a fingerprint too. Confirm only if it’s the same as this one.
        </p>
        <p
          className="pairing-fingerprint mono"
          aria-label={`Fingerprint ${fingerprint.replace(' ', '').split('').join(' ')}`}
        >
          {fingerprint}
        </p>
        <p className="hint">
          If they differ, something other than the Bridge app answered: cancel, and start again in
          the app.
        </p>
        <div className="pair-row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={busy}
            onClick={confirm}
          >
            {busy ? 'Pairing…' : 'They match'}
          </button>
          <button type="button" className="btn btn-lg" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  }

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

/** The app, the project it has open, and Unpair. */
function ConnectionSection({ project }: { project: ProjectInfo | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <section aria-labelledby="connection-label">
      <div className="label-row">
        <p className="label" id="connection-label">
          Connection
        </p>
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void request({ type: 'unpair' }).finally(() => setBusy(false));
          }}
        >
          Unpair
        </button>
      </div>
      {project?.missing ? (
        <>
          <p className="value">{project.name}</p>
          <p className="notice" role="status">
            The project folder is missing. It may have been moved, renamed or unmounted. Open it
            again in the Bridge app.
          </p>
        </>
      ) : project ? (
        <>
          <p className="value">{project.name}</p>
          <p className="hint mono path" title={project.path}>
            {project.path}
          </p>
        </>
      ) : (
        <>
          <p className="value">No project open</p>
          <p className="hint">Open a project folder in the Bridge app to start.</p>
        </>
      )}
    </section>
  );
}

/** Placeholder rows while the worker hasn't answered yet. */
function Loading() {
  return (
    <section aria-busy="true" aria-label="Loading">
      <span className="skeleton short" />
      <span className="skeleton" />
      <span className="skeleton" />
    </section>
  );
}

function Body({
  status,
  project,
  config,
  fullAutoOff,
  chat,
  live
}: {
  status: ConnectionStatus;
  project: ProjectInfo | null;
  config: BridgeConfig | null;
  fullAutoOff: boolean;
  chat: ChatPanelState;
  live: LiveRun | null;
}) {
  const [busy, setBusy] = useState(false);
  const act = (message: WorkerRequest) => {
    setBusy(true);
    void request(message).finally(() => setBusy(false));
  };
  const session = chat.session;
  const active = session?.state === 'active';

  switch (status) {
    case 'not-paired':
      return <PairForm />;
    case 'connected':
      return (
        <>
          <ConnectionSection project={project} />
          <SessionSection chat={chat} project={project} />
          <ModeSection config={config} fullAutoOff={fullAutoOff} />
          <LoopSection config={config} loop={chat.loop} />
          <CommandSection config={config} live={live} />
          {active && <Requests requests={chat.requests} />}
          {active && <ContextFiles files={session.context} watch={chat.watch} />}
          {/* Applied edits can add files, so the tree reloads when the count changes. */}
          {active && project && !project.missing && (
            <SendFiles project={project} version={session.applied} />
          )}
          {import.meta.env.DEV && <PageDiagnostics />}
          {import.meta.env.DEV && <DevFileTester />}
        </>
      );
    case 'connecting':
      return (
        <section>
          <p className="label">Connection</p>
          <p className="value">Connecting to the Bridge app…</p>
          <p className="hint">This takes a second or two. Keep the Bridge app open.</p>
        </section>
      );
    case 'app-not-running':
    case 'error':
      return (
        <section>
          <p className="label">Connection</p>
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
  const { update, live } = useWorker();
  const status = update?.status ?? null;
  // A worker from an older build sends no chat state. Show "no chat" instead of crashing.
  const chat = update?.chat ? { ...NO_CHAT, ...update.chat } : NO_CHAT;

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
        {!update && <Loading />}
        {update && (
          <Body
            status={update.status}
            project={update.project}
            config={update.config ?? null}
            fullAutoOff={update.fullAutoOff}
            chat={chat}
            live={live}
          />
        )}
      </main>
      {update?.status === 'connected' && <LoopFooter loop={chat.loop} />}
    </div>
  );
}
