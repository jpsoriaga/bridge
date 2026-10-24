import { useState } from 'react';
import { FILE_ERROR_LABELS } from '@bridge/shared';
import type { ContextEntry, ContextResendResult, PendingRequest } from '../messages';
import { formatCount, panelWindowId, redactedText, request, sessionErrorText } from './request';

const REQUEST_KINDS: Record<PendingRequest['kind'], string> = {
  read: 'Files',
  run: 'Run',
  start: 'Start',
  download: 'Download'
};

/**
 * Files sent to the chat this session, newest first, with how much of the message each
 * took. A file that changed on disk since it was sent is marked stale (the app's watcher
 * tells the extension, which compares hashes); **Resend changed** sends those again.
 */
export function ContextFiles({
  files,
  watch
}: {
  files: ContextEntry[];
  watch: 'watch' | 'poll' | null;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone?: 'danger' } | null>(null);
  const changed = files.filter((f) => f.stale || f.missing);
  const total = files.reduce((sum, f) => sum + f.chars, 0);

  const resend = () => {
    setBusy(true);
    setResult(null);
    void panelWindowId()
      .then((windowId) => request<ContextResendResult>({ type: 'context-resend', windowId }))
      .then((outcome) => {
        if (!outcome.ok) {
          setResult({ text: sessionErrorText(outcome.error), tone: 'danger' });
          return;
        }
        const refused = outcome.refused
          .map(({ path, code }) => `${path} (${FILE_ERROR_LABELS[code]})`)
          .join(', ');
        setResult({
          text:
            outcome.sent.length > 0
              ? `Added ${outcome.sent.length} changed ${outcome.sent.length === 1 ? 'file' : 'files'} to the message box. Review it and press send.${refused ? ` Not sent: ${refused}.` : ''}${redactedText(outcome.redacted)}`
              : `Nothing to send.${refused ? ` Not sent: ${refused}.` : ''}`
        });
      })
      .catch(() => setResult({ text: sessionErrorText('failed'), tone: 'danger' }))
      .finally(() => setBusy(false));
  };

  const remove = (path: string) =>
    void panelWindowId().then((windowId) => request({ type: 'context-remove', windowId, path }));

  return (
    <section aria-labelledby="context-label">
      <div className="label-row">
        <p className="label" id="context-label">
          Files in context
        </p>
        {changed.length > 0 && (
          <button type="button" className="btn" disabled={busy} onClick={resend}>
            {busy ? 'Adding…' : `Resend changed (${changed.length})`}
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="hint">
          Files you send to the chat show up here, with how much of the message each one took.
        </p>
      ) : (
        <>
          <ul className="context-list" aria-label="Files sent to the chat">
            {[...files].reverse().map((file) => (
              <li key={file.path} className="context-row" data-stale={file.stale || file.missing}>
                <span className="context-path mono" title={file.path}>
                  {file.path}
                </span>
                {file.missing ? (
                  <span className="tag" data-tone="danger">
                    deleted
                  </span>
                ) : file.stale ? (
                  <span className="tag" data-tone="warning">
                    changed
                  </span>
                ) : null}
                <span className="context-size">
                  {file.chars > 0 ? `${formatCount(file.chars)} chars` : ''}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${file.path} from the list`}
                  title="Remove from list"
                  onClick={() => remove(file.path)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">
            {files.length} {files.length === 1 ? 'file' : 'files'} · about {formatCount(total)}{' '}
            characters sent.
            {changed.length > 0 &&
              ` ${changed.length} changed on disk since; the chat has the old version.`}
          </p>
          {watch === 'poll' && (
            <p className="hint">
              This project is too big to watch every file, so Bridge checks only these.
            </p>
          )}
        </>
      )}
      {result && (
        <p className={result.tone ? 'error-text' : 'hint'} role="status">
          {result.text}
        </p>
      )}
    </section>
  );
}

/** READ and RUN cards in the active tab still waiting for a click, with Show. */
export function Requests({ requests }: { requests: PendingRequest[] }) {
  const reveal = (id: string) =>
    void panelWindowId().then((windowId) => request({ type: 'reveal-request', windowId, id }));
  return (
    <section aria-labelledby="requests-label">
      <p className="label" id="requests-label">
        Requests
      </p>
      {requests.length === 0 ? (
        <p className="hint">Nothing waiting. Files and commands the chat asks for show up here.</p>
      ) : (
        <ul className="request-list">
          {requests.map((item) => (
            <li key={item.id} className="request-row">
              <span className="request-kind">{REQUEST_KINDS[item.kind]}</span>
              <span className="request-text mono" title={item.text}>
                {item.kind === 'run' || item.kind === 'start' ? `$ ${item.text}` : item.text}
              </span>
              {!item.allowed && (
                <span className="tag" data-tone="danger">
                  {item.kind === 'read' ? 'blocked' : 'not allowed'}
                </span>
              )}
              <button type="button" className="btn" onClick={() => reveal(item.id)}>
                Show
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
