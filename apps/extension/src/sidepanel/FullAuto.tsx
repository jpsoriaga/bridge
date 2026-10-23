import {
  formatArgv,
  LOOP_NOTE_TEXT,
  LOOP_STATE_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  pauseReasonText,
  type BridgeConfig,
  type LoopReport,
  type RunResult
} from '@bridge/shared';
import type { LoopAction, WorkerRequest } from '../messages';
import { panelWindowId, request } from './request';

/** Lines of live output the panel keeps. The card in the chat has the rest. */
const OUTPUT_LINES = 200;

export interface LiveRun {
  runId: string;
  text: string;
  result: RunResult | null;
}

/** Appends a chunk of output, keeping the last `OUTPUT_LINES` lines. */
export function appendOutput(text: string, chunk: string): string {
  const next = text + chunk;
  const lines = next.split('\n');
  return lines.length > OUTPUT_LINES ? lines.slice(-OUTPUT_LINES).join('\n') : next;
}

const loopRequest = (action: LoopAction) =>
  void panelWindowId().then((windowId) =>
    request({ type: 'loop-control', windowId, action } satisfies WorkerRequest)
  );

/** The app's mode, read-only here: it's switched in the Bridge app. */
export function ModeSection({
  config,
  fullAutoOff = false
}: {
  config: BridgeConfig | null;
  fullAutoOff?: boolean;
}) {
  return (
    <section>
      <p className="label">Mode</p>
      {config ? (
        <>
          <p className="value mode-value">
            <span className="mode-badge" data-mode={config.mode}>
              {MODE_LABELS[config.mode]}
            </span>
          </p>
          <p className="hint">
            {MODE_DESCRIPTIONS[config.mode]} Change the mode in the Bridge app.
          </p>
          {fullAutoOff && config.mode !== 'full-auto' && (
            <p className="hint" data-tone="warning" role="status">
              Full auto turned off: it’s per session.
            </p>
          )}
        </>
      ) : (
        <p className="hint">Shown once the Bridge app is connected.</p>
      )}
    </section>
  );
}

/** Full auto in the active tab: where it is, why it paused, and how to carry on. */
export function LoopSection({
  config,
  loop
}: {
  config: BridgeConfig | null;
  loop: LoopReport | null;
}) {
  if (config?.mode !== 'full-auto' && !loop) return null;
  const state = loop?.state ?? 'idle';
  const tone =
    state === 'paused'
      ? 'warning'
      : state === 'idle' || state === 'stopped'
        ? undefined
        : 'success';
  return (
    <section>
      <p className="label">Full auto</p>
      <p className="status session-status">
        <span className="dot" data-tone={tone} />
        <span>
          {state === 'idle'
            ? 'Waiting for a reply with edits, files or commands'
            : loop?.note && state !== 'paused'
              ? LOOP_NOTE_TEXT[loop.note]
              : LOOP_STATE_LABELS[state]}
          {loop && state !== 'idle' && ` · ${loop.step} / ${loop.limit}`}
        </span>
      </p>
      {state === 'paused' && loop?.reason && (
        <p className="notice" role="status">
          {pauseReasonText(loop.reason, loop.detail)}
        </p>
      )}
      {state === 'paused' && <PauseActions loop={loop} stepLimit={config?.stepLimit} />}
      {state === 'stopped' && (
        <>
          <p className="hint">Stopped. Nothing was reverted; undo is still available.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => loopRequest('resume')}>
              Allow Full auto again
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** How to carry on from a pause: the reason decides which buttons, one of them primary. */
function PauseActions({ loop, stepLimit }: { loop: LoopReport | null; stepLimit?: number }) {
  const button = (action: LoopAction, label: string, primary = false) => (
    <button
      key={action}
      type="button"
      className={primary ? 'btn btn-primary' : 'btn'}
      onClick={() => loopRequest(action)}
    >
      {label}
    </button>
  );
  const buttons = (() => {
    switch (loop?.reason) {
      case 'step-limit':
        return [button('continue', `Continue for ${stepLimit ?? loop.limit} more`, true)];
      case 'stalled':
        return [button('stop-continue', 'Stop & continue', true)];
      case 'interrupted':
        // The page's own Continue generating keeps the same reply, so it comes first.
        return loop.pageContinue
          ? [button('continue-reply', 'Continue generating', true), button('resume', 'Resume')]
          : [button('resume', 'Resume', true)];
      case 'command-interrupted':
        return [button('resume', 'Re-run', true), button('skip', 'Skip')];
      default:
        return [button('resume', 'Resume', true)];
    }
  })();
  return (
    <>
      {loop?.reason === 'stalled' && (
        <p className="hint">
          Stop & continue stops the reply, applies what came through whole and asks the chat to
          continue.
        </p>
      )}
      {loop?.reason === 'interrupted' && (
        <p className="hint">
          Resume applies what came through whole and asks the chat to continue from there.
        </p>
      )}
      <div className="actions">{buttons}</div>
    </>
  );
}

/** The command running now (anyone's), with its output as it streams. */
export function CommandSection({
  config,
  live
}: {
  config: BridgeConfig | null;
  live: LiveRun | null;
}) {
  const running = config?.running ?? null;
  if (!running && !live) return null;
  const command = running
    ? formatArgv(running.argv)
    : live?.result
      ? formatArgv(live.result.argv)
      : '';
  const result = live?.result ?? null;
  const ended =
    result === null
      ? null
      : result.status === 'exited'
        ? result.exitCode === 0
          ? 'Passed'
          : `Failed (exit ${result.exitCode ?? '?'})`
        : result.status === 'timed-out'
          ? 'Timed out'
          : result.status === 'cancelled'
            ? 'Cancelled'
            : 'Couldn’t start';
  return (
    <section>
      <div className="label-row">
        <p className="label">Command</p>
        {running && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void request({ type: 'run-cancel' })}
          >
            Cancel
          </button>
        )}
      </div>
      <p className="value mono command-line" title={command}>
        $ {command}
      </p>
      <p
        className="hint"
        data-tone={
          result && !(result.status === 'exited' && result.exitCode === 0) ? 'danger' : undefined
        }
      >
        {running ? 'Running…' : ended}
      </p>
      {live && live.text && <pre className="command-output">{live.text}</pre>}
    </section>
  );
}

/** Sticky footer while a loop runs: the step counter and Stop. */
export function LoopFooter({ loop }: { loop: LoopReport | null }) {
  if (!loop || loop.state === 'idle' || loop.state === 'stopped') return null;
  return (
    <footer className="panel-footer">
      <span className="step-count">
        Step {loop.step} of {loop.limit}
      </span>
      <button type="button" className="btn btn-danger" onClick={() => loopRequest('stop')}>
        Stop
      </button>
    </footer>
  );
}
