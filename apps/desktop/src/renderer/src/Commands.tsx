import { useEffect, useState, type FormEvent } from 'react';
import {
  COMMAND_REJECTION_TEXT,
  DEFAULT_STEP_LIMIT,
  isInstallCommand,
  MAX_RUN_TIMEOUT_MS,
  MAX_STEP_LIMIT,
  MIN_RUN_TIMEOUT_MS,
  deniedArgument,
  parseAllowlistEntry,
  parseCommand,
  programName
} from '@bridge/shared';
import type {
  AutoApproveSettings,
  CommandPath,
  DesktopState,
  RunSettings
} from '../../preload/api';

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

/** Why an allowlist entry can't be saved, or null. A trailing `*` allows extra arguments. */
export function commandError(entry: string): string | null {
  const rule = parseAllowlistEntry(entry);
  if (!rule) {
    const parsed = parseCommand(entry.replace(/\s\*$/, ''));
    return parsed.ok
      ? 'Use * only as the last word, to allow extra arguments.'
      : COMMAND_REJECTION_TEXT[parsed.reason];
  }
  const denied = deniedArgument(rule.words);
  if (denied !== null) {
    return programName(rule.words[0] ?? '') === denied.toLowerCase() || rule.words[0] === denied
      ? `Bridge never runs ${denied}: it downloads and runs other programs.`
      : `Bridge never allows ${denied} with this program: it could run other code, write files or change folders.`;
  }
  return null;
}

/** Marks a command the app runs in the background (`@@START`) rather than to completion. */
function BackgroundTag() {
  return (
    <span className="badge" title="Started with @@START and kept running">
      background
    </span>
  );
}

/** First open: the suggested commands, each with a checkbox, and Allow. */
function Suggestions({
  suggestions,
  background
}: {
  suggestions: string[];
  background: readonly string[];
}) {
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
              {background.includes(entry) && <BackgroundTag />}
            </label>
          </li>
        ))}
      </ul>
      {suggestions.some((entry) => isInstallCommand(entry.split(' '))) && <InstallHint />}
      {background.length > 0 && <BackgroundHint />}
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

/** What a background entry is. */
function BackgroundHint() {
  return (
    <p className="hint">
      Background commands (dev servers, watchers) keep running between messages. The chat starts
      them with <span className="mono">@@START</span> and stops them with{' '}
      <span className="mono">@@STOP</span>; at most three run at once, and all of them stop when the
      session ends, you switch projects or quit.
    </p>
  );
}

/** What allowing the install command means, under the suggestion and the one-time note. */
function InstallHint() {
  return (
    <p className="hint">
      The install command installs only what package.json lists, and runs those packages’ install
      scripts. The chat can’t add a package with it, and changes to package.json always need your
      click.
    </p>
  );
}

/** Once, for a list confirmed before Bridge suggested the install command. */
function InstallNote({ command }: { command: string }) {
  const [busy, setBusy] = useState(false);
  const answer = (add: boolean) => {
    setBusy(true);
    void window.bridge.answerInstallNote(add).finally(() => setBusy(false));
  };
  return (
    <div className="notice" role="status">
      <p>
        Add <span className="mono">{command}</span> to the allowlist? The chat can then install
        dependencies after you approve a package.json change.
      </p>
      <InstallHint />
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          aria-label={`Add ${command}`}
          onClick={() => answer(true)}
        >
          Add
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => answer(false)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** The project's allowlist. Only the app edits it; the chat and the extension can't. */
function Allowlist({
  entries,
  background,
  note,
  installNote
}: {
  entries: string[];
  background: readonly string[];
  note: boolean;
  installNote: string | null;
}) {
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

  const setBackground = (entry: string, on: boolean) =>
    void window.bridge
      .setBackgroundEntries(on ? [...background, entry] : background.filter((e) => e !== entry))
      .then((result) => setError(result.ok ? null : 'Bridge couldn’t save that.'));

  return (
    <>
      <p className="hint">
        The chat can run exactly these. End one with <span className="mono">*</span> to allow extra
        arguments after it (<span className="mono">pnpm test *</span>). Anything else is refused,
        and so are shell syntax and options that run other code or change folders (such as{' '}
        <span className="mono">node -e</span> or <span className="mono">git -C</span>), even with{' '}
        <span className="mono">*</span>.
      </p>
      <BackgroundHint />
      {note && (
        <div className="notice" role="status">
          <p>
            Allowlist entries now match exactly. Your saved ones got a{' '}
            <span className="mono">*</span>, so they still allow extra arguments as before. Remove
            the <span className="mono">*</span> from any that don’t need it.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => void window.bridge.dismissAllowlistNote()}
          >
            Got it
          </button>
        </div>
      )}
      {installNote !== null && <InstallNote command={installNote} />}
      {entries.length === 0 ? (
        <p className="empty">No commands allowed in this project. Add one below.</p>
      ) : (
        <ul className="patterns">
          {entries.map((entry) => (
            <li key={entry}>
              <span className="mono">{entry}</span>
              <label className="check check-inline">
                <input
                  type="checkbox"
                  checked={background.includes(entry)}
                  aria-label={`Run ${entry} in the background`}
                  onChange={(e) => setBackground(entry, e.target.checked)}
                />
                <span>Background</span>
              </label>
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
          : `Use timeouts of ${MIN_RUN_TIMEOUT_MS / 1000}–${MAX_RUN_TIMEOUT_MS / 1000} seconds and a step limit of 1–${MAX_STEP_LIMIT}, or Unlimited.`
      );
    });
  };
  return { save, error };
}

/** How long one command may run before Bridge stops it, and an install command. */
export function TimeoutField({ settings }: { settings: RunSettings }) {
  const [timeout, setTimeoutValue] = useState(String(settings.timeoutMs / 1000));
  const [install, setInstall] = useState(String(settings.installTimeoutMs / 1000));
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
      <label className="field">
        <span>Install timeout</span>
        <span className="field-input">
          <input
            className="input mono"
            type="number"
            min={MIN_RUN_TIMEOUT_MS / 1000}
            max={MAX_RUN_TIMEOUT_MS / 1000}
            aria-invalid={error !== null}
            value={install}
            onChange={(e) => setInstall(e.target.value)}
            onBlur={() => save({ installTimeoutMs: Math.round(Number(install) * 1000) })}
          />
          <span className="unit">seconds</span>
        </span>
      </label>
      <p className="hint">
        For <span className="mono">npm install</span>, <span className="mono">pnpm install</span>,{' '}
        <span className="mono">yarn install</span> and <span className="mono">bun install</span>,
        which download packages.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Full auto's step limit (or Unlimited), whether a failing command pauses it, and sleep. */
export function FullAutoFields({
  settings,
  noteSeen
}: {
  settings: RunSettings;
  noteSeen: boolean;
}) {
  const unlimited = settings.stepLimit === null;
  const [steps, setSteps] = useState(String(settings.stepLimit ?? DEFAULT_STEP_LIMIT));
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
            disabled={unlimited}
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            onBlur={() => save({ stepLimit: Math.round(Number(steps)) })}
          />
          <span className="unit">messages</span>
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={unlimited}
          onChange={(e) =>
            save({
              stepLimit: e.target.checked ? null : Math.round(Number(steps)) || DEFAULT_STEP_LIMIT
            })
          }
        />
        <span>Unlimited</span>
      </label>
      <p className="hint">
        {unlimited
          ? 'Full auto keeps going until the chat says it’s done or you press Stop.'
          : 'The most messages Full auto sends on its own in one run before it pauses for you.'}{' '}
        Either way it pauses when the same failure repeats three times.
      </p>
      {unlimited && !noteSeen && (
        <div className="notice" role="status">
          <p>
            On the Free and Go plans, each step uses one of your messages, so a long run can use up
            your limit. Full auto still pauses on repeated failures (the same command failing the
            same way, or the same file written the same way, three times).
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => void window.bridge.dismissUnlimitedNote()}
          >
            Got it
          </button>
        </div>
      )}
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
      <label className="check">
        <input
          type="checkbox"
          checked={settings.catchUpAfterSleep}
          onChange={(e) => save({ catchUpAfterSleep: e.target.checked })}
        />
        <span>Catch up automatically after sleep</span>
      </label>
      <p className="hint">
        On, Full auto waits for the chat’s reply after your computer wakes and carries on. A reply
        that was cut off gets one request to continue. Off, Full auto pauses until you click Resume.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const AUTO_APPROVE: { key: keyof AutoApproveSettings; label: string; risk: string }[] = [
  {
    key: 'changes',
    label: 'Deletes and renames',
    risk: 'Full auto deletes and moves files the chat names without asking.'
  },
  {
    key: 'gated',
    label: 'Gated files (package.json, lockfiles, configs)',
    risk: 'Full auto changes the files that decide what install, build and test commands run, then may run them.'
  },
  {
    key: 'partial',
    label: 'Partial-looking files',
    risk: 'Full auto writes files that look cut short (“…rest unchanged”), which can replace a whole file with part of it.'
  }
];

/**
 * Full auto → "Also approve automatically": what it may do without a click that otherwise
 * waits for one. Turning one on asks in a native dialog first.
 */
export function AutoApproveFields({ value }: { value: AutoApproveSettings }) {
  const [busy, setBusy] = useState(false);
  const toggle = (key: keyof AutoApproveSettings, on: boolean) => {
    setBusy(true);
    void window.bridge.setAutoApprove({ ...value, [key]: on }).finally(() => setBusy(false));
  };
  const any = AUTO_APPROVE.some(({ key }) => value[key]);
  return (
    <fieldset className="run-settings">
      <legend className="subsection-title">Also approve automatically</legend>
      <p className="hint">
        Off by default. Each change is backed up, so you can undo it. Commands off the allowlist,
        downloads, protected files (<span className="mono">.env</span>,{' '}
        <span className="mono">.git</span>, keys) and files that changed on disk always wait for
        you.
      </p>
      {AUTO_APPROVE.map(({ key, label, risk }) => (
        <div key={key}>
          <label className="check">
            <input
              type="checkbox"
              checked={value[key]}
              disabled={busy}
              onChange={(e) => toggle(key, e.target.checked)}
            />
            <span>{label}</span>
          </label>
          {value[key] && (
            <p className="hint" data-tone="warning">
              {risk}
            </p>
          )}
        </div>
      ))}
      {any && (
        <p className="hint">
          Activity marks everything Full auto approved this way “auto-approved”.
        </p>
      )}
    </fieldset>
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
      background={state.background}
    />
  ) : (
    <Allowlist
      entries={state.allowlist}
      background={state.background}
      note={state.allowlistNote}
      installNote={state.installNote}
    />
  );
}
