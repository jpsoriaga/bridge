import { useEffect, useRef, useState } from 'react';
import { LOOP_STATE_LABELS, PAUSE_REASON_TEXT, type LoopReport } from '@bridge/shared';
import type { ActivityEntry, DesktopState } from '../../preload/api';

const active = (loop: LoopReport | null) =>
  loop !== null && loop.state !== 'idle' && loop.state !== 'stopped';

/** Under the mode switch: what the Full auto loop is doing, as the extension reports it. */
export function LoopStatus({ state }: { state: DesktopState }) {
  const { loop } = state;
  if (state.mode !== 'full-auto' && !active(loop)) return null;
  const tone = loop?.state === 'paused' ? 'warning' : active(loop) ? 'success' : undefined;
  return (
    <div className="loop-status">
      <p className="status">
        <span className="dot" data-tone={tone} />
        {!loop || loop.state === 'idle'
          ? 'Full auto is on. It starts when a reply asks for edits, files or commands.'
          : `${LOOP_STATE_LABELS[loop.state]} · step ${loop.step} of ${loop.limit}`}
      </p>
      {loop?.state === 'paused' && loop.reason && (
        <p className="hint" data-tone="warning">
          {PAUSE_REASON_TEXT[loop.reason]} Resume from the side panel in Chrome.
        </p>
      )}
    </div>
  );
}

/** Sticky above the footer while a loop runs: the step counter and Stop. */
export function LoopBar({ loop }: { loop: LoopReport | null }) {
  // "Stopping…" lasts until the loop reports a new state (or a new run starts).
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const at = `${loop?.loopId}:${loop?.state}:${loop?.step}`;
  const stopping = stoppedAt === at;
  if (!active(loop)) return null;
  return (
    <div className="loop-bar">
      <span className="step-count">
        Step {loop!.step} of {loop!.limit}
      </span>
      <button
        type="button"
        className="btn btn-danger"
        disabled={stopping}
        onClick={() => {
          setStoppedAt(at);
          void window.bridge.stopLoop();
        }}
      >
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );
}

/** A short note when Bridge applies an edit on its own. */
export function AutoToast({ entries }: { entries: ActivityEntry[] }) {
  const seen = useRef<Set<string> | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const autos = entries.filter(
      (e) => e.trigger === 'auto' && (e.kind === 'create' || e.kind === 'modify') && !e.undone
    );
    if (seen.current === null) {
      // What was already there when the window opened isn't news.
      seen.current = new Set(autos.map((e) => e.id));
      return;
    }
    const fresh = autos.filter((e) => !seen.current!.has(e.id));
    for (const e of fresh) seen.current.add(e.id);
    if (fresh.length === 0) return;
    setToast(
      fresh.length === 1 ? `Auto-applied ${fresh[0]!.path}` : `Auto-applied ${fresh.length} files`
    );
    const timer = setTimeout(() => setToast(null), 4_000);
    return () => clearTimeout(timer);
  }, [entries]);

  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span className="dot" data-tone="success" />
      <span className="toast-text">{toast}</span>
      <span className="toast-hint">Undo it in Activity.</span>
    </div>
  );
}
