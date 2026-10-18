import { useEffect, useState, type FormEvent } from 'react';
import {
  COMMAND_REJECTION_TEXT,
  DEFAULT_STEP_LIMIT,
  MAX_RUN_TIMEOUT_MS,
  MAX_STEP_LIMIT,
  MIN_RUN_TIMEOUT_MS,
  parseCommand
} from '@bridge/shared';
import type { CommandPath, DesktopState, RunSettings } from '../../preload/api';

/** The last lines of the running command's output, kept here as it streams. */
const OUTPUT_LINES = 300;

function useRunOutput(runId: string | null): string {
  const [output, setOutput] = useState<{ runId: string | null; text: string }>({
    runId: null,
    text: ''
  });
  useEffect(
    () =>
      window.bridge.onRunOutput(({ runId: id, text }) =>
        setOutput((prev) => {
          const next = (prev.runId === id ? prev.text : '') + text;
          const lines = next.split('\n');
          return {
            runId: id,
            text: lines.length > OUTPUT_LINES ? lines.slice(-OUTPUT_LINES).join('\n') : next
          };
        })
      ),
    []
  );
  return runId !== null && output.runId === runId ? output.text : '';
}

function commandError(entry: string): string | null {
  const parsed = parseCommand(entry);
  return parsed.ok ? null : COMMAND_REJECTION_TEXT[parsed.reason];
}

/** First open: the suggested commands, each with a checkbox, and Allow. */
function Suggestions({ suggestions }: { suggestions: string[] }) {
  const [picked, setPicked] = useState<string[]>(suggestions);
  const [busy, setBusy] = useState(false);
  const toggle = (entry: string) =>
    setPicked((list) =>
      list.includes(entry) ? list.filter((e) => e !== entry) : [...list, entry]
    );
  const confirm = (entries: string[]) => {
    setBusy(true);
    void window.bridge.setAllowlist(entries).finally(() => setBusy(false));
  };
  return (
    <>
      <p className="hint">
        {suggestions.length === 0
          ? 'Bridge found no check scripts in this project. Confirm an empty list, then add commands below if you want any.'
          : 'Bridge found these in the project. Nothing runs until you confirm the list. You can change it at any time.'}
      </p>
      <ul className="patterns suggestions">
        {suggestions.map((entry) => (
          <li key={entry}>
            <label className="check">
              <input
                type="checkbox"
                checked={picked.includes(entry)}
                onChange={() => toggle(entry)}
              />
              <span className="mono">{entry}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => confirm(picked)}
        >
          {picked.length === 0 ? 'Allow no commands' : `Allow ${picked.length} commands`}
        </button>
      </div>
    </>
  );
}

/** The project's allowlist. Only the app edits it; the chat and the extension can't. */
function Allowlist({ entries }: { entries: string[] }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = (next: string[]) =>
    window.bridge.setAllowlist(next).then((result) => {
      setError(result.ok ? null : 'That isn’t a single command Bridge can run.');
      return result.ok;
    });

  const add = (event: FormEvent) => {
    event.preventDefault();
    const entry = draft.trim().replace(/\s+/g, ' ');
    if (!entry) return;
    const problem = commandError(entry);
    if (problem) {
      setError(problem);
      return;
    }
    if (entries.includes(entry)) {
      setDraft('');
      return;
    }
    void save([...entries, entry]).then((ok) => ok && setDraft(''));
  };

  return (
    <>
      <p className="hint">
        The chat can ask for these, plus extra arguments after them. Anything else is refused, and
        so is any shell syntax.
      </p>
      {entries.length === 0 ? (
        <p className="empty">No commands allowed in this project. Add one below.</p>
      ) : (
        <ul className="patterns">
          {entries.map((entry) => (
            <li key={entry}>
              <span className="mono">{entry}</span>
              <button
                type="button"
                className="btn"
                aria-label={`Remove ${entry}`}
                onClick={() => void save(entries.filter((e) => e !== entry))}
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
          placeholder="pnpm test"
          aria-label="Add an allowed command"
          aria-invalid={error !== null}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
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
    </>
  );
}

/** Saves one field of the run settings, keeping the rest as they are. */
function useRunSettings(settings: RunSettings) {
  const [error, setError] = useState<string | null>(null);
  const save = (patch: Partial<RunSettings>) => {
    void window.bridge.setRunSettings({ ...settings, ...patch }).then((ok) => {
      setError(
        ok
          ? null
          : `Use a timeout of ${MIN_RUN_TIMEOUT_MS / 1000}–${MAX_RUN_TIMEOUT_MS / 1000} seconds and a step limit of 1–${MAX_STEP_LIMIT}.`
      );
    });
  };
  return { save, error };
}

/** How long one command may run before Bridge stops it. */
export function TimeoutField({ settings }: { settings: RunSettings }) {
  const [timeout, setTimeoutValue] = useState(String(settings.timeoutMs / 1000));
  const { save, error } = useRunSettings(settings);
  return (
    <div className="run-settings">
      <label className="field">
        <span>Command timeout</span>
        <span className="field-input">
          <input
            className="input mono"
            type="number"
            min={MIN_RUN_TIMEOUT_MS / 1000}
            max={MAX_RUN_TIMEOUT_MS / 1000}
            aria-invalid={error !== null}
            value={timeout}
            onChange={(e) => setTimeoutValue(e.target.value)}
            onBlur={() => save({ timeoutMs: Math.round(Number(timeout) * 1000) })}
          />
          <span className="unit">seconds</span>
        </span>
      </label>
      <p className="hint">Bridge stops a command, and anything it started, after this long.</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Full auto's step limit and whether a failing command pauses it. */
export function FullAutoFields({ settings }: { settings: RunSettings }) {
  const [steps, setSteps] = useState(String(settings.stepLimit));
  const { save, error } = useRunSettings(settings);
  return (
    <div className="run-settings">
      <label className="field">
        <span>Step limit</span>
        <span className="field-input">
          <input
            className="input mono"
            type="number"
            min={1}
            max={MAX_STEP_LIMIT}
            placeholder={String(DEFAULT_STEP_LIMIT)}
            aria-invalid={error !== null}
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            onBlur={() => save({ stepLimit: Math.round(Number(steps)) })}
          />
          <span className="unit">messages</span>
        </span>
      </label>
      <p className="hint">
        The most messages Full auto sends on its own in one run before it pauses for you.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.pauseOnFailure}
          onChange={(e) => save({ pauseOnFailure: e.target.checked })}
        />
        <span>Pause Full auto when a command fails</span>
      </label>
      <p className="hint">
        Off by default, so failing tests go back to the chat to fix. On, Full auto stops at the
        first non-zero exit and waits for you.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const PATH_SOURCES: Record<Exclude<CommandPath['source'], null>, string> = {
  'login-shell': 'From your login shell.',
  inherited: 'Bridge’s own PATH.',
  fallback: 'Bridge’s own PATH, because your login shell couldn’t be read.',
  override: 'Your override.'
};

/** The PATH commands get, where it came from, and a field to override it. */
export function PathOverride({ commandPath }: { commandPath: CommandPath }) {
  const [draft, setDraft] = useState(commandPath.override);
  const [error, setError] = useState<string | null>(null);
  const save = (value: string) =>
    void window.bridge.setPathOverride(value).then((ok) => {
      setError(ok ? null : 'Use a PATH with at least one absolute folder, separated by “:”.');
      if (ok) setDraft(value.trim());
    });
  return (
    <div className="pattern-list">
      <h3 className="subsection-title">PATH for commands</h3>
      <p className="hint">
        {commandPath.source === null
          ? 'Reading your login shell…'
          : PATH_SOURCES[commandPath.source]}{' '}
        <span className="mono path-value" title={commandPath.path}>
          {commandPath.path || '(empty)'}
        </span>
      </p>
      {commandPath.warning && commandPath.source === 'fallback' && (
        <p className="hint" data-tone="warning" role="status">
          {commandPath.warning} If a command says “not found”, set the PATH below. In a terminal,{' '}
          <span className="mono">echo $PATH</span> prints yours.
        </p>
      )}
      <form
        className="pattern-form"
        onSubmit={(e) => {
          e.preventDefault();
          save(draft);
        }}
      >
        <input
          className="input mono"
          placeholder="/opt/homebrew/bin:/usr/bin:/bin"
          aria-label="PATH override"
          aria-invalid={error !== null}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn" disabled={draft.trim() === commandPath.override}>
          Save
        </button>
        {commandPath.override && (
          <button type="button" className="btn" onClick={() => save('')}>
            Clear
          </button>
        )}
      </form>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The running command and its output as it streams. */
export function RunningCommand({ state }: { state: DesktopState }) {
  const running = state.running;
  const output = useRunOutput(running?.runId ?? null);
  if (!running) return null;
  return (
    <section>
      <div className="section-head">
        <p className="label">Running</p>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void window.bridge.cancelRun()}
        >
          Cancel
        </button>
      </div>
      <p className="value mono command-line" title={running.command}>
        $ {running.command}
      </p>
      <pre className="command-output" aria-live="polite">
        {output || 'Starting…'}
      </pre>
    </section>
  );
}

/** The project's allowlist: the suggestions to confirm first, then the list itself. */
export function AllowlistEditor({ state }: { state: DesktopState }) {
  if (!state.project) {
    return <p className="empty">Open a project to choose which commands the chat may run.</p>;
  }
  return state.allowlist === null ? (
    <Suggestions
      key={`${state.project.path}:${state.allowlistSuggestions.join('|')}`}
      suggestions={state.allowlistSuggestions}
    />
  ) : (
    <Allowlist entries={state.allowlist} />
  );
}
