import { useEffect, useState } from 'react';
import {
  formatUptime,
  processTone,
  type BackgroundLogs,
  type BackgroundProcess
} from '@bridge/shared';
import type { RequestOutcome } from '../messages';
import { request } from './request';

/** How often an open log refreshes. */
const LOG_REFRESH_MS = 2_000;

/** Re-renders every second while `active`, for uptimes. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function ProcessRow({ proc, now }: { proc: BackgroundProcess; now: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<BackgroundLogs | null>(null);
  const running = proc.state === 'running';
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    const load = () =>
      void request<RequestOutcome<BackgroundLogs>>({ type: 'process-logs', procId: proc.procId })
        .then((outcome) => !stopped && setLogs(outcome.ok ? outcome.result : null))
        .catch(() => undefined);
    load();
    const id = running ? setInterval(load, LOG_REFRESH_MS) : undefined;
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [open, running, proc.procId]);
  const status = running
    ? `${proc.url ? 'Running' : 'Starting'} · ${formatUptime(now - proc.startedAt)}`
    : proc.state === 'stopped'
      ? 'Stopped'
      : `Exited${proc.exitCode !== null ? ` (exit ${proc.exitCode})` : ''}`;
  // Red only for a failure or a kill; a clean exit is neutral.
  const tone = processTone(proc);
  return (
    <li className="process-row">
      <div className="label-row">
        <span className="status">
          <span className="dot" data-tone={tone} />
          <span className="mono process-command" title={proc.command}>
            {proc.command}
          </span>
        </span>
        {running && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void request({ type: 'process-stop', procId: proc.procId }).finally(() =>
                setBusy(false)
              );
            }}
          >
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        )}
      </div>
      <p className="hint">
        {status}
        {proc.url && running && (
          <>
            {' · '}
            <button
              type="button"
              className="link-button mono"
              onClick={() => void request({ type: 'process-open', procId: proc.procId })}
            >
              {proc.url}
            </button>
          </>
        )}
        {' · '}
        <button
          type="button"
          className="link-button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide logs' : 'View logs'}
        </button>
      </p>
      {open && (
        <pre className="command-output">
          {logs === null
            ? 'Loading…'
            : logs.lines.length === 0
              ? '(no output yet)'
              : logs.lines.join('\n')}
        </pre>
      )}
    </li>
  );
}

/** Background processes (dev servers) the chat started: URL, uptime, Stop and logs. */
export function ProcessesSection({ processes }: { processes: readonly BackgroundProcess[] }) {
  const now = useNow(processes.some((p) => p.state === 'running'));
  if (processes.length === 0) return null;
  return (
    <section aria-labelledby="processes-label">
      <p className="label" id="processes-label">
        Background processes
      </p>
      <ul className="process-list">
        {processes.map((proc) => (
          <ProcessRow key={proc.procId} proc={proc} now={now} />
        ))}
      </ul>
    </section>
  );
}
