import { useEffect, useState } from 'react';
import { formatUptime, type BackgroundLogs, type BackgroundProcess } from '@bridge/shared';
import { useNow } from './hooks';

/** How often an open log refreshes. */
const LOG_REFRESH_MS = 2_000;

/** A process's log while it's shown, refreshed every couple of seconds. */
function useLogs(procId: string, open: boolean, live: boolean): BackgroundLogs | null {
  const [logs, setLogs] = useState<BackgroundLogs | null>(null);
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    const load = () =>
      void window.bridge.getProcessLogs(procId).then((value) => !stopped && setLogs(value));
    load();
    const id = live ? setInterval(load, LOG_REFRESH_MS) : undefined;
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [procId, open, live]);
  return open ? logs : null;
}

function ended(proc: BackgroundProcess): string {
  if (proc.state === 'stopped') return 'Stopped';
  if (proc.exitCode !== null)
    return proc.exitCode === 0 ? 'Exited' : `Exited (exit ${proc.exitCode})`;
  return proc.signal ? `Ended by ${proc.signal}` : 'Exited';
}

function ProcessRow({ proc, now }: { proc: BackgroundProcess; now: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = proc.state === 'running';
  const logs = useLogs(proc.procId, open, running);
  const tone = running
    ? proc.url
      ? 'success'
      : 'warning'
    : proc.state === 'exited'
      ? 'danger'
      : undefined;
  return (
    <li className="process-row">
      <div className="process-head">
        <span className="dot" data-tone={tone} />
        <span className="mono process-command" title={proc.command}>
          {proc.command}
        </span>
        <span className="hint process-meta">
          {running
            ? `${proc.url ? 'Running' : 'Starting'} · ${formatUptime(now - proc.startedAt)}`
            : ended(proc)}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="link-button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide logs' : 'View logs'}
        </button>
        {running && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void window.bridge.stopProcess(proc.procId).finally(() => setBusy(false));
            }}
          >
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      {proc.url && running && (
        <button
          type="button"
          className="link-button mono process-url"
          onClick={() => void window.bridge.openProcessUrl(proc.procId)}
        >
          {proc.url}
        </button>
      )}
      {open && (
        <pre className="command-output" tabIndex={0} aria-label={`Output of ${proc.command}`}>
          {logs === null
            ? 'Loading…'
            : logs.lines.length === 0
              ? '(no output yet)'
              : logs.lines.slice(-300).join('\n')}
        </pre>
      )}
    </li>
  );
}

/**
 * Background processes (dev servers) the chat started with `@@START`: each with its URL
 * (opens in the browser), how long it's run, Stop and its logs.
 */
export function BackgroundProcesses({ processes }: { processes: BackgroundProcess[] }) {
  const now = useNow(processes.some((p) => p.state === 'running'));
  if (processes.length === 0) return null;
  return (
    <section aria-labelledby="processes-title">
      <h2 className="section-title" id="processes-title">
        Background processes
      </h2>
      <ul className="processes">
        {processes.map((proc) => (
          <ProcessRow key={proc.procId} proc={proc} now={now} />
        ))}
      </ul>
      <p className="hint">
        They stop when the chat session ends, you switch projects, quit Bridge or the computer
        sleeps for more than 30 minutes.
      </p>
    </section>
  );
}
