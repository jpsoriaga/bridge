import { useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';

// System, Light or Dark, as the app's Appearance setting. "System" removes data-theme so
// tokens.css follows prefers-color-scheme. The choice is kept in localStorage (public/theme.js
// reads it before the first paint); if storage is blocked it lasts for the visit only.

export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'bridge-theme';

const OPTIONS: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' }
];

export function readTheme(): ThemeChoice {
  const current = document.documentElement.dataset.theme;
  return current === 'light' || current === 'dark' ? current : 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage blocked: the choice holds until the page is closed.
  }
}

// The choice lives on <html data-theme>, so the switch reads it from there.
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function ThemeSwitch() {
  // The prerendered HTML can't know the saved theme, so it says System; once hydrated the
  // switch shows the theme public/theme.js already applied.
  const choice = useSyncExternalStore(subscribe, readTheme, () => 'system');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const choose = (value: ThemeChoice) => applyTheme(value);

  // Arrow keys move and choose, as in a radio group.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = OPTIONS.findIndex((o) => o.value === choice);
    const next = (index + step + OPTIONS.length) % OPTIONS.length;
    choose(OPTIONS[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label="Theme" className="segmented" onKeyDown={onKeyDown}>
      {OPTIONS.map((option, i) => (
        <button
          key={option.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={choice === option.value}
          aria-label={option.label}
          title={option.label}
          tabIndex={choice === option.value ? 0 : -1}
          onClick={() => choose(option.value)}
        >
          <Icon name={option.icon} size={14} />
        </button>
      ))}
    </div>
  );
}
