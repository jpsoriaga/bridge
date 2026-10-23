import { useEffect, useRef, useState } from 'react';
import {
  LOOP_NOTE_TEXT,
  LOOP_STATE_LABELS,
  pauseReasonText,
  type LoopReport
} from '@bridge/shared';
import type { ActivityEntry, DesktopState } from '../../preload/api';
import type { Tone } from './errors';

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
          : `${loop.note && loop.state !== 'paused' ? LOOP_NOTE_TEXT[loop.note] : LOOP_STATE_LABELS[loop.state]} · step ${loop.step} of ${loop.limit}`}
      </p>
      {loop?.state === 'paused' && loop.reason && (
        <p className="hint" data-tone="warning">
          {pauseReasonText(loop.reason, loop.detail)} Resume from the side panel in Chrome.
        </p>
      )}
    </div>
  );
}

/**
 * Under the header on every page while a Full auto run is going: where it is, and Stop.
 * Stop (also ⌘. and the Session menu) halts the loop and its command, reverting nothing.
 */
export function LoopStrip({ loop }: { loop: LoopReport | null }) {
  // "Stopping…" lasts until the loop reports a new state (or a new run starts).
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const at = `${loop?.loopId}:${loop?.state}:${loop?.step}`;
  const stopping = stoppedAt === at;
  if (!active(loop)) return null;
  const paused = loop!.state === 'paused';
  return (
    <div className="loop-strip" role="region" aria-label="Full auto run">
      <span className="dot" data-tone={paused ? 'warning' : 'success'} />
      <span className="loop-strip-text">
        <strong>Full auto</strong> ·{' '}
        {loop!.note && !paused ? LOOP_NOTE_TEXT[loop!.note] : LOOP_STATE_LABELS[loop!.state]}
        {paused && loop!.reason ? ` · ${pauseReasonText(loop!.reason, loop!.detail)}` : ''}
      </span>
      <span className="step-count">
        Step {loop!.step} of {loop!.limit}
      </span>
      <button
        type="button"
        className="btn btn-danger"
        disabled={stopping}
        aria-keyshortcuts="Meta+Period"
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

export interface Toast {
  id: string;
  tone: Tone;
  text: string;
  /** Mono text after the message, e.g. a path. */
  detail?: string;
  hint?: string;
}

const TOAST_MS = 4_000;

/** Background events worth a toast, from one state to the next. */
export function toastsFor(
  before: { state: DesktopState | null; entries: ActivityEntry[] | null },
  after: { state: DesktopState | null; entries: ActivityEntry[] | null }
): Toast[] {
  const toasts: Toast[] = [];
  if (before.entries && after.entries) {
    const seen = new Set(before.entries.map((e) => e.id));
    const autos = after.entries.filter(
      (e) =>
        !seen.has(e.id) &&
        e.trigger === 'auto' &&
        (e.kind === 'create' || e.kind === 'modify') &&
        !e.undone
    );
    if (autos.length === 1) {
      toasts.push({
        id: `auto:${autos[0]!.id}`,
        tone: 'success',
        text: 'Auto-applied',
        detail: autos[0]!.path,
        hint: 'Undo it in Activity.'
      });
    } else if (autos.length > 1) {
      toasts.push({
        id: `auto:${autos[0]!.id}`,
        tone: 'success',
        text: `Auto-applied ${autos.length} files`,
        hint: 'Undo them in Activity.'
      });
    }
  }
  const was = before.state;
  const now = after.state;
  if (was && now) {
    const loopWas = was.loop;
    const loopNow = now.loop;
    if (loopNow && loopNow.state !== loopWas?.state) {
      if (loopNow.state === 'paused') {
        toasts.push({
          id: `loop:${loopNow.loopId}:${loopNow.step}:paused`,
          tone: 'warning',
          text: 'Full auto paused',
          hint: loopNow.reason ? pauseReasonText(loopNow.reason, loopNow.detail) : undefined
        });
      } else if (loopNow.state === 'idle' && active(loopWas)) {
        toasts.push({
          id: `loop:${loopNow.loopId}:done`,
          tone: undefined,
          text: 'Full auto run finished',
          hint: loopNow.event?.text
        });
      }
    }
    if (now.sessionResets > was.sessionResets) {
      toasts.push({
        id: `session-reset:${now.sessionResets}`,
        tone: 'warning',
        text: 'Full auto turned off: it’s per session.',
        hint: 'Auto-apply and Manual carry over between sessions.'
      });
    }
    if (now.project?.missing && !was.project?.missing) {
      toasts.push({
        id: `missing:${now.project.path}`,
        tone: 'warning',
        text: 'Project folder missing',
        hint: 'It may have been moved, renamed or unmounted.'
      });
    }
    const update = now.about.update;
    if (update?.state === 'available' && was.about.update?.state !== 'available') {
      toasts.push({
        id: `update:${update.version}`,
        tone: undefined,
        text: `Bridge ${update.version} is available`,
        hint: 'Settings → About has the link.'
      });
    }
    if (now.about.diagnosticsCopied > was.about.diagnosticsCopied) {
      toasts.push({
        id: `diagnostics:${now.about.diagnosticsCopied}`,
        tone: 'success',
        text: 'Diagnostics copied',
        hint: 'Paste them into your bug report.'
      });
    }
    if (was.status === 'connected' && now.status !== 'connected' && now.paired) {
      toasts.push({
        id: `disconnected:${Date.now()}`,
        tone: undefined,
        text: 'Extension disconnected'
      });
    }
  }
  return toasts;
}

/** Toasts for things that happen while you're looking elsewhere. Each lasts 4 seconds. */
export function Toasts({
  state,
  entries
}: {
  state: DesktopState | null;
  entries: ActivityEntry[] | null;
}) {
  const previous = useRef<{ state: DesktopState | null; entries: ActivityEntry[] | null }>({
    state: null,
    entries: null
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const before = previous.current;
    previous.current = { state, entries };
    // What was there when the window opened isn't news.
    if (!before.state || !before.entries) return;
    const fresh = toastsFor(before, { state, entries });
    if (fresh.length === 0) return;
    setToasts((current) =>
      [...current.filter((t) => !fresh.some((f) => f.id === t.id)), ...fresh].slice(-3)
    );
    for (const toast of fresh) {
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setToasts((current) => current.filter((t) => t.id !== toast.id));
      }, TOAST_MS);
      timers.current.add(timer);
    }
  }, [state, entries]);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          <span className="dot" data-tone={toast.tone} />
          <span className="toast-text">
            {toast.text}
            {toast.detail && <span className="mono toast-detail"> {toast.detail}</span>}
          </span>
          {toast.hint && <span className="toast-hint">{toast.hint}</span>}
        </div>
      ))}
    </div>
  );
}
