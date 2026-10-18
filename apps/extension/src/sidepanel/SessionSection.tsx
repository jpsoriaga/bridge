import { useEffect, useState } from 'react';
import { COMPOSER_WARN_CHARS, type ProjectInfo } from '@bridge/shared';
import type { ChatPanelState, SessionPreview, SessionStartResult } from '../messages';
import { formatCount, panelWindowId, request, sessionErrorText } from './request';

const shortId = (id: string) => (id.length > 8 ? `${id.slice(0, 8)}…` : id);

function usePreview(enabled: boolean, project: ProjectInfo | null) {
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const projectPath = project?.path;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void panelWindowId()
      .then((windowId) => request<SessionPreview>({ type: 'session-preview', windowId }))
      .then((result) => live && setPreview(result))
      .catch(() => live && setPreview({ ok: false, error: 'failed' }));
    return () => {
      live = false;
    };
  }, [enabled, projectPath]);
  return enabled ? preview : null;
}

function StartSession({ project, restart }: { project: ProjectInfo | null; restart: boolean }) {
  const preview = usePreview(true, project);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setBusy(true);
    setError(null);
    void panelWindowId()
      .then((windowId) => request<SessionStartResult>({ type: 'session-start', windowId }))
      .then((result) => {
        if (!result.ok) setError(sessionErrorText(result.error));
      })
      .catch(() => setError(sessionErrorText('failed')))
      .finally(() => setBusy(false));
  };

  const over = preview?.ok === true && preview.chars > COMPOSER_WARN_CHARS;
  return (
    <>
      <p className="hint">
        {restart
          ? 'The session for this chat ended. Start again to keep applying edits here.'
          : 'Puts instructions and your file list in the message box. You press send.'}
      </p>
      {preview?.ok && (
        <p className="hint" data-tone={over ? 'warning' : undefined}>
          {formatCount(preview.chars)} characters, {formatCount(preview.shown)} of{' '}
          {formatCount(preview.total)} files listed.
          {over && ' The chat may turn this into an attachment or cut it off.'}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary btn-lg action"
        disabled={busy || (preview !== null && !preview.ok)}
        onClick={start}
      >
        {busy ? 'Starting…' : 'Start session'}
      </button>
      {(error ?? (preview && !preview.ok ? sessionErrorText(preview.error) : null)) && (
        <p className="error-text" role="alert">
          {error ?? (preview && !preview.ok ? sessionErrorText(preview.error) : '')}
        </p>
      )}
    </>
  );
}

/** Start, end or move the chat session in the active tab, and its stats. */
export function SessionSection({
  chat,
  project
}: {
  chat: ChatPanelState;
  project: ProjectInfo | null;
}) {
  const [ending, setEnding] = useState(false);
  const { tab, session } = chat;

  if (!tab) {
    return (
      <section>
        <p className="label">Session</p>
        <p className="value">No chat in this tab</p>
        <p className="hint">
          Open a chat in this tab to start a session. If one is already open, Bridge isn’t running
          in it yet: chat tabs opened before Bridge was installed or reloaded need a reload.
        </p>
        <button
          type="button"
          className="btn action"
          onClick={() =>
            void panelWindowId().then((windowId) => request({ type: 'reload-tab', windowId }))
          }
        >
          Reload this tab
        </button>
      </section>
    );
  }

  if (tab.layout === 'unknown') {
    return (
      <section>
        <p className="label">Session</p>
        <p className="notice" role="status">
          Bridge can’t read this page layout. The chat page may have changed. Cards and sessions are
          off until Bridge is updated.
        </p>
      </section>
    );
  }

  if (!project) {
    return (
      <section>
        <p className="label">Session</p>
        <p className="value">No session</p>
        <p className="hint">Open a project folder in the Bridge app to start one.</p>
      </section>
    );
  }

  if (session?.state === 'elsewhere') {
    return (
      <section>
        <p className="label">Session</p>
        <p className="status session-status">
          <span className="dot" />
          <span>Session active in another tab</span>
        </p>
        <p className="hint">
          A session belongs to one tab, so cards here are off. Move it here to use this tab instead;
          the other tab stops.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-lg action"
          onClick={() =>
            void panelWindowId().then((windowId) => request({ type: 'session-move', windowId }))
          }
        >
          Move here
        </button>
      </section>
    );
  }

  if (!session || session.state === 'ended') {
    return (
      <section>
        <p className="label">Session</p>
        <p className="value">{session ? 'Session ended' : 'No session'}</p>
        <StartSession project={project} restart={session !== null} />
      </section>
    );
  }

  const end = () => {
    setEnding(true);
    void panelWindowId()
      .then((windowId) => request({ type: 'session-end', windowId }))
      .finally(() => setEnding(false));
  };

  return (
    <>
      <section>
        <div className="label-row">
          <p className="label">Session</p>
          <button type="button" className="btn" disabled={ending} onClick={end}>
            End session
          </button>
        </div>
        <p className="status session-status">
          <span className="dot" data-tone="success" />
          {session.conversationId ? (
            <span>
              Session active ·{' '}
              <span className="mono" title={session.conversationId}>
                {shortId(session.conversationId)}
              </span>
            </span>
          ) : (
            <span>Session active · waiting for your first message</span>
          )}
        </p>
        <ul className="activity session-stats">
          <li className="activity-row">
            <span className="dot" data-tone={session.applied > 0 ? 'success' : undefined} />
            <span className="activity-text">
              {session.applied} {session.applied === 1 ? 'edit' : 'edits'} applied
            </span>
          </li>
          <li className="activity-row">
            <span className="dot" data-tone={session.pending > 0 ? 'warning' : undefined} />
            <span className="activity-text">{session.pending} waiting for review</span>
          </li>
        </ul>
      </section>
    </>
  );
}
