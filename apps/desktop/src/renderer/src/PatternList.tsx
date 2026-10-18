import { useState, type FormEvent, type ReactNode } from 'react';
import type { SaveListResult } from '../../preload/api';

/**
 * A built-in list shown read-only, then the user's own entries with **Remove**, and a field
 * to add one. Protected files, gated files and the environment filter all look like this.
 */
export function PatternList({
  label,
  hint,
  defaults,
  patterns,
  placeholder,
  invalidText,
  save
}: {
  label: string;
  hint: ReactNode;
  defaults: readonly string[];
  patterns: string[];
  placeholder: string;
  invalidText: string;
  save: (patterns: string[]) => Promise<SaveListResult>;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apply = (next: string[]) =>
    save(next).then((result) => {
      setError(result.ok ? null : invalidText);
      return result.ok;
    });

  const add = (event: FormEvent) => {
    event.preventDefault();
    const pattern = draft.trim();
    if (!pattern) return;
    void apply([...patterns, pattern]).then((ok) => ok && setDraft(''));
  };

  return (
    <div className="pattern-list">
      <h3 className="subsection-title">{label}</h3>
      <p className="hint">
        {hint} <span className="mono">{defaults.join('  ')}</span>
      </p>
      {patterns.length === 0 ? (
        <p className="empty">None added.</p>
      ) : (
        <ul className="patterns">
          {patterns.map((pattern) => (
            <li key={pattern}>
              <span className="mono">{pattern}</span>
              <button
                type="button"
                className="btn"
                aria-label={`Remove ${pattern}`}
                onClick={() => void apply(patterns.filter((p) => p !== pattern))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="pattern-form" onSubmit={add}>
        <input
          className="input mono"
          placeholder={placeholder}
          aria-label={`Add to ${label.toLowerCase()}`}
          aria-invalid={error !== null}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!draft.trim()}>
          Add
        </button>
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
