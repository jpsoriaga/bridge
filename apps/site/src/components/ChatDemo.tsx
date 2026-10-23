import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { useReducedMotion } from '../lib/motion';
import { Icon } from './Icon';
import { Logo } from './Logo';

// The hero's picture: a short loop of what Bridge does, drawn like the real chat cards and
// side panel (DESIGN.md "Diff card", "RUN card", "Activity log row"), not a video. The chat
// is asked for a loading state, the reply carries an @@FILE block, Bridge shows its diff, the
// cursor clicks Apply, and the side panel logs the write and the allowed test command passing.
// About 12s a loop, ending with everything fading out together and a short empty pause; it
// stops off screen, in a hidden tab, when paused, and under reduced motion, where it shows
// the final frame.

const STEPS = [
  // Everything jumps back to its start, unseen, then a beat of empty frame.
  { name: 'empty', ms: 600 },
  { name: 'ask', ms: 700 },
  { name: 'reply', ms: 450 },
  { name: 'marker', ms: 350 },
  { name: 'code', ms: 1300 },
  { name: 'card', ms: 1200 },
  // The cursor's trip (--motion-travel) and a short pause before the click.
  { name: 'point', ms: 950 },
  { name: 'press', ms: 150 },
  { name: 'applied', ms: 600 },
  { name: 'logged', ms: 700 },
  { name: 'run', ms: 500 },
  { name: 'output', ms: 900 },
  { name: 'pass', ms: 600 },
  { name: 'ran', ms: 2400 },
  // Every part fades out together (--motion-slow).
  { name: 'exit', ms: 400 }
] as const;

type StepName = (typeof STEPS)[number]['name'];

const index = (name: StepName): number => STEPS.findIndex((s) => s.name === name);

/** The frame the page is prerendered with, and the one reduced motion keeps. */
export const FINAL_STEP: StepName = 'ran';
const FINAL = index(FINAL_STEP);

export const PATH = 'src/components/Button.tsx';

const CODE = [
  "type ButtonProps = React.ComponentProps<'button'> & {",
  '  loading?: boolean;',
  '};',
  '',
  'export function Button({ loading, disabled, children, ...rest }: ButtonProps) {',
  '  return (',
  '    <button {...rest} disabled={disabled || loading} aria-busy={loading}>',
  '      {loading && <span className="spinner" aria-hidden />}',
  '      {children}',
  '    </button>',
  '  );',
  '}'
];

const DIFF: { kind: 'hunk' | 'ctx' | 'add' | 'del'; text: string }[] = [
  { kind: 'hunk', text: '@@ -1,6 +1,9 @@' },
  { kind: 'del', text: "- type ButtonProps = React.ComponentProps<'button'>;" },
  { kind: 'add', text: "+ type ButtonProps = React.ComponentProps<'button'> & {" },
  { kind: 'add', text: '+   loading?: boolean;' },
  { kind: 'add', text: '+ };' },
  { kind: 'ctx', text: '  ' },
  { kind: 'del', text: '- export function Button({ disabled, children, ...rest }: ButtonProps) {' },
  {
    kind: 'add',
    text: '+ export function Button({ loading, disabled, children, ...rest }: ButtonProps) {'
  },
  { kind: 'ctx', text: '    return (' },
  { kind: 'del', text: '-     <button {...rest} disabled={disabled}>' },
  {
    kind: 'add',
    text: '+     <button {...rest} disabled={disabled || loading} aria-busy={loading}>'
  },
  { kind: 'add', text: '+       {loading && <span className="spinner" aria-hidden />}' },
  { kind: 'ctx', text: '        {children}' }
];

const ADDED = DIFF.filter((row) => row.kind === 'add').length;
const REMOVED = DIFF.filter((row) => row.kind === 'del').length;

const OUTPUT = [
  ' ✓ Button.test.tsx (3 tests) 24ms',
  ' Test Files  1 passed (1)',
  '      Tests  3 passed (3)'
];

// Monochrome highlighting for the reply's TSX: keywords, strings, JSX tags and punctuation,
// each a neutral token (index.css, ".tsx-*").
const TOKEN =
  /('[^']*'|"[^"]*")|\b(type|export|function|return)\b|(<\/?[a-z]+|\/?>)|([{}()[\];:&|=.?,<>]+)/g;
const KINDS = ['tsx-str', 'tsx-kw', 'tsx-tag', 'tsx-punct'] as const;

function highlight(line: string) {
  const parts: { text: string; kind?: (typeof KINDS)[number] }[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    if (match.index > last) parts.push({ text: line.slice(last, match.index) });
    const group = match.slice(1).findIndex((g) => g !== undefined);
    parts.push({ text: match[0], kind: KINDS[group] });
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts.map((part, i) =>
    part.kind ? (
      <span key={i} className={part.kind}>
        {part.text}
      </span>
    ) : (
      part.text
    )
  );
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const tabVisible = () => document.visibilityState !== 'hidden';

/** Whether the element is on screen; true where IntersectionObserver doesn't exist. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

const on = (shown: boolean) => (shown ? '' : undefined);

// Reject, Apply and Undo: one size, so the pair matches and the swap to Undo doesn't move.
const BUTTON = 'btn btn-lg min-w-20';

type Cursor = 'away' | 'button' | 'press';

export function ChatDemo() {
  const figure = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const visible = useSyncExternalStore(subscribeVisibility, tabVisible, () => true);
  const onScreen = useOnScreen(figure);
  const [paused, setPaused] = useState(false);
  // Starts on the final frame, as prerendered, and holds it before the first loop.
  const [step, setStep] = useState(FINAL);

  const playing = !reduced && !paused && visible && onScreen;
  const frame = reduced ? FINAL : step;

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEPS[step]!.ms);
    return () => clearTimeout(timer);
  }, [playing, step]);

  const name = STEPS[frame]!.name;
  // The exit fades what's there, so it counts as the last frame.
  const at = (when: StepName) => name === 'exit' || frame >= index(when);
  const applied = at('applied');
  const cursor: Cursor = name === 'press' ? 'press' : at('point') ? 'button' : 'away';
  const phase = name === 'exit' ? 'exit' : name === 'empty' ? 'reset' : undefined;

  const togglePause = () => {
    if (!paused) setStep(FINAL);
    setPaused(!paused);
  };

  return (
    <figure
      ref={figure}
      className="m-0 w-full min-w-0 overflow-hidden rounded-xl border border-border bg-bg"
      aria-labelledby="demo-caption"
      data-step={name}
      data-playing={playing}
    >
      <div className="flex h-11 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold">Chat</span>
        <span className="text-xs text-fg-muted">chatgpt.com</span>
        {reduced ? null : (
          <button
            type="button"
            className="ml-auto inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs text-fg-muted transition-colors duration-(--motion-fast) hover:bg-bg-muted hover:text-fg"
            aria-pressed={paused}
            onClick={togglePause}
          >
            <Icon name={paused ? 'play' : 'pause'} size={12} />
            {paused ? 'Play' : 'Pause'}
            <span className="sr-only"> the example</span>
          </button>
        )}
      </div>

      <div
        className="demo-stage grid lg:grid-cols-[minmax(0,1fr)_20rem]"
        data-phase={phase}
        aria-hidden="true"
      >
        <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-6 lg:px-10 lg:py-8">
          <p
            className="demo-part m-0 max-w-[85%] self-end rounded-xl bg-bg-muted px-4 py-2.5 text-base"
            data-on={on(at('ask'))}
          >
            Add a loading state to the Button component
          </p>

          <div className="text-base leading-normal">
            <p className="demo-part m-0" data-on={on(at('reply'))}>
              It takes a <code className="font-mono text-sm">loading</code> prop now, and stays
              disabled while it’s set:
            </p>
            <p className="demo-part mt-2 mb-0" data-on={on(at('marker'))}>
              <code className="rounded-sm bg-bg-muted px-[5px] py-px text-sm">@@FILE {PATH}@@</code>
            </p>
            <pre
              className="demo-part mt-2 mb-0 overflow-hidden rounded-lg bg-bg-muted px-4 py-3 font-mono text-xs leading-5 text-fg"
              data-on={on(at('marker'))}
            >
              {CODE.map((line, i) => (
                <span
                  key={i}
                  className="demo-part demo-line block min-h-5"
                  style={{ transitionDelay: `calc(${i} * var(--motion-stagger))` }}
                  data-on={on(at('code'))}
                >
                  {highlight(line)}
                </span>
              ))}
            </pre>
          </div>

          <div
            className={`demo-part demo-card relative rounded-lg border bg-bg ${
              applied ? 'border-border' : 'border-border-strong'
            }`}
            data-on={on(at('card'))}
          >
            <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2">
              <Icon name="file" className="text-fg-muted" />
              <span className="min-w-0 truncate font-mono text-sm">{PATH}</span>
              <span className="badge">modified</span>
              <span className="text-xs text-fg-muted">
                <span className="text-success">+{ADDED}</span>{' '}
                <span className="text-danger">−{REMOVED}</span>
              </span>
            </div>
            <div className="overflow-hidden border-t border-border py-1">
              {DIFF.map((row, i) => (
                <span key={i} className="diff-row text-xs leading-5" data-kind={row.kind}>
                  {row.text}
                </span>
              ))}
            </div>
            <div className="demo-swap rounded-b-lg border-t border-border bg-bg-hover">
              <div className="flex items-center gap-3 px-4 py-3" data-on={on(!applied)}>
                <p className="m-0 flex min-w-0 items-center gap-2 text-xs text-fg-muted">
                  <span className="font-medium text-fg">Manual</span>
                  <span className="h-3 w-px bg-border-strong" />
                  <span className="hidden sm:inline">Review before applying.</span>
                </p>
                <span className="ml-auto flex gap-2">
                  <span className={BUTTON} data-demo-button="reject">
                    Reject
                  </span>
                  <span className="relative">
                    <span
                      className={`demo-press ${BUTTON} btn-primary`}
                      data-demo-button="apply"
                      data-pressed={on(cursor === 'press')}
                    >
                      Apply
                    </span>
                    <Pointer at={cursor} />
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2 px-4 py-3" data-on={on(applied)}>
                <Icon name="pencil" className="text-fg-muted" />
                <span className="text-sm font-medium">Modified</span>
                <span className="text-xs text-fg-muted">· just now</span>
                <span className={`${BUTTON} ml-auto`}>Undo</span>
              </div>
            </div>
          </div>
        </div>

        <SidePanel at={at} />
      </div>

      <figcaption id="demo-caption" className="sr-only">
        Example: you ask the chat to add a loading state to the Button component. Its reply has the
        new {PATH}, and Bridge shows the change as a diff card under it. Nothing is written until
        you click Apply; then the card reads Modified, and Bridge’s side panel logs the write and
        runs the allowed command npm test, which passes.
      </figcaption>
    </figure>
  );
}

/** The Bridge side panel beside the chat, on wide screens only. */
function SidePanel({ at }: { at: (when: StepName) => boolean }) {
  const passed = at('pass');
  return (
    <div className="hidden min-w-0 flex-col border-l border-border lg:flex">
      <div className="flex h-12 items-center gap-2 border-b border-border px-5">
        <Logo size={20} />
        <span className="text-base font-semibold tracking-[-0.01em]">Bridge</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-fg-muted">
          <span className="dot" data-tone="success" />
          Connected
        </span>
      </div>
      <div className="flex flex-col gap-6 px-5 py-5">
        <div>
          <p className="m-0 mb-2 text-xs text-fg-muted">Project</p>
          <p className="m-0 text-base">my-react-app</p>
          <p className="m-0 truncate font-mono text-xs text-fg-muted">~/code/my-react-app</p>
        </div>
        <div>
          <p className="m-0 mb-2 text-xs text-fg-muted">Mode</p>
          <span className="segmented w-full">
            {['Manual', 'Auto-apply', 'Full auto'].map((mode, i) => (
              <span
                key={mode}
                className={`flex h-[26px] items-center justify-center rounded-md px-1 text-xs ${
                  i === 0 ? 'bg-bg-raised font-semibold text-fg shadow-xs' : 'text-fg-muted'
                }`}
              >
                {mode}
              </span>
            ))}
          </span>
        </div>
        <div>
          <p className="m-0 mb-3 text-xs text-fg-muted">Activity</p>
          <ul className="m-0 flex list-none flex-col gap-3 p-0" data-demo="activity">
            <li className="demo-part flex items-start gap-2" data-on={on(at('logged'))}>
              <Icon name="pencil" className="mt-0.5 text-fg-muted" />
              <span className="min-w-0">
                <span className="block truncate text-sm">
                  Modified <span className="font-mono">{PATH}</span>
                </span>
                <span className="block text-xs text-fg-muted">Just now · via chat</span>
              </span>
            </li>
            <li
              className="demo-part rounded-lg border border-dashed border-border-strong"
              data-on={on(at('run'))}
            >
              <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
                <span className="font-mono text-sm text-fg-subtle">$</span>
                <span className="font-mono text-sm">npm test</span>
                <span className="demo-swap ml-auto">
                  <span className="badge" data-tone="warning" data-on={on(!passed)}>
                    running
                  </span>
                  <span className="badge" data-tone="success" data-on={on(passed)}>
                    exit 0
                  </span>
                </span>
              </div>
              <div className="border-t border-dashed border-border-strong px-3 py-2 font-mono text-xs leading-5 whitespace-pre text-fg-muted">
                {OUTPUT.map((line, i) => (
                  <span
                    key={i}
                    className="demo-part demo-line block overflow-hidden text-ellipsis"
                    style={{ transitionDelay: `calc(${i * 3} * var(--motion-stagger))` }}
                    data-on={on(at('output'))}
                  >
                    {line}
                  </span>
                ))}
              </div>
            </li>
            <li className="demo-part flex items-start gap-2" data-on={on(at('ran'))}>
              <span className="dot mt-1.5" />
              <span className="min-w-0">
                <span className="block text-sm">
                  Ran <span className="font-mono">npm test</span> · exit 0
                </span>
                <span className="block text-xs text-fg-muted">Just now · 0.8s</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * The macOS-style pointer that clicks Apply: a black arrow with a white edge and a soft shadow,
 * 24px tall. Its tip, at (2, 2), is the click point; the outer span moves it across, the inner
 * one down, each on its own curve.
 */
function Pointer({ at }: { at: Cursor }) {
  return (
    <span className="demo-cursor" data-at={at} aria-hidden="true">
      <span>
        <svg width="17" height="24" viewBox="0 0 17 24" focusable="false">
          <path
            d="M2 2v17.6l4.4-4.1 2.9 6.4 2.9-1.2-2.8-6.3H15z"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  );
}
