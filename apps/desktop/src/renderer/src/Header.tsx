import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CONNECTION_STATUS_TONES, MODE_LABELS, type ConnectionStatus } from '@bridge/shared';
import type { DesktopState, OpenFolderResult } from '../../preload/api';
import { OPEN_ERRORS } from './errors';
import { Icon } from './Icon';
import { Logo } from './Logo';

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  'app-not-running': 'Not running',
  'not-paired': 'Not paired',
  connecting: 'Waiting for extension',
  connected: 'Connected',
  error: 'Server error'
};

/**
 * The open project and a menu to switch: recent projects, then Open folder…. Arrow keys
 * move through it, Escape closes it and returns focus to the button.
 */
export function ProjectSwitcher({
  state,
  onError
}: {
  state: DesktopState;
  onError: (text: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const { project, recentProjects } = state;
  const others = recentProjects
    .map((recent, index) => ({ ...recent, index }))
    .filter((recent) => recent.path !== project?.path);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && event.target !== button.current) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const run = (action: () => Promise<OpenFolderResult>) => {
    setOpen(false);
    setBusy(true);
    onError(null);
    void action()
      .then((result) => onError(result.ok ? null : OPEN_ERRORS[result.reason]))
      .finally(() => {
        setBusy(false);
        button.current?.focus();
      });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items.at(-1))?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="switcher">
      <button
        ref={button}
        type="button"
        className="switcher-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        title={project?.path}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="folder" />
        <span className="switcher-name">{project ? project.name : 'No project'}</span>
        {project?.missing && (
          <span className="tag" data-tone="warning">
            missing
          </span>
        )}
        <Icon name="chevron" className="icon icon-sm" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="menu"
          role="menu"
          aria-label="Switch project"
          onKeyDown={onKeyDown}
        >
          {others.length > 0 && <p className="menu-label">Recent</p>}
          {others.map((recent) => (
            <button
              key={recent.path}
              type="button"
              role="menuitem"
              className="menu-item"
              title={recent.path}
              onClick={() => run(() => window.bridge.openRecent(recent.index))}
            >
              <span>{recent.name}</span>
              <span className="mono menu-path">{recent.path}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => run(() => window.bridge.openFolder())}
          >
            <span>Open folder…</span>
            <span className="menu-shortcut" aria-hidden="true">
              {IS_MAC ? '⌘O' : 'Ctrl+O'}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The 56px bar: brand, project switcher, connection and mode. */
export function Header({
  state,
  onOpenError,
  onShowMode
}: {
  state: DesktopState | null;
  onOpenError: (text: string | null) => void;
  onShowMode: () => void;
}) {
  const status = state?.status ?? 'connecting';
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <span>Bridge</span>
      </div>
      {state && <ProjectSwitcher state={state} onError={onOpenError} />}
      <span className="spacer" />
      <span
        className="status"
        role="status"
        aria-label={`Extension: ${state ? STATUS_LABELS[status] : 'starting'}`}
      >
        <span className="dot" data-tone={CONNECTION_STATUS_TONES[status]} />
        {state ? STATUS_LABELS[status] : 'Starting…'}
      </span>
      {state && (
        <button
          type="button"
          className="mode-pill"
          data-mode={state.mode}
          aria-label={`Mode: ${MODE_LABELS[state.mode]}. Change it on the Session page.`}
          onClick={onShowMode}
        >
          {MODE_LABELS[state.mode]}
        </button>
      )}
    </header>
  );
}
