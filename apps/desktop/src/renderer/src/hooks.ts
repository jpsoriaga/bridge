import { useEffect, useState } from 'react';
import type { ActivityEntry, DesktopState } from '../../preload/api';

/** Re-renders every second while `active`, for countdowns. */
export function useNow(active: boolean): number {
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

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const formatTime = (time: number) =>
  new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The app's state from main, pushed on every change. Null until the first one arrives. */
export function useDesktopState(): DesktopState | null {
  const [state, setState] = useState<DesktopState | null>(null);
  useEffect(() => {
    const unsubscribe = window.bridge.onStatus(setState);
    void window.bridge.getStatus().then(setState);
    return unsubscribe;
  }, []);
  return state;
}

/** The open project's activity, newest first. Null until loaded. */
export function useActivity(): ActivityEntry[] | null {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  useEffect(() => {
    const unsubscribe = window.bridge.onActivity(setEntries);
    void window.bridge.getActivity().then(setEntries);
    return unsubscribe;
  }, []);
  return entries;
}
