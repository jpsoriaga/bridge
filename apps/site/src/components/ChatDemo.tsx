import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { useReducedMotion } from '../lib/motion';
import { Icon } from './Icon';
import { Logo } from './Logo';

// The hero's picture: a short loop of what Bridge does, drawn like the real chat cards and
// side panel (DESIGN.md "Diff card", "RUN card", "Activity log row"), not a video. The chat
// asks for a fix, the reply carries an @@FILE block, Bridge shows its diff, the cursor clicks
// Apply, and the allowed test command passes. About 10s a loop; it stops off screen, in a
// hidden tab, when paused, and under reduced motion, where it shows the final frame.

const STEPS = [
  { name: 'clear', ms: 450 },
  { name: 'ask', ms: 800 },
  { name: 'reply', ms: 550 },
  { name: 'marker', ms: 350 },
  { name: 'code', ms: 750 },
  { name: 'card', ms: 1400 },
  { name: 'point', ms: 750 },
  { name: 'press', ms: 260 },
  { name: 'applied', ms: 1000 },
  { name: 'run', ms: 1000 },
  { name: 'pass', ms: 2800 },
  { name: 'fade', ms: 450 }
] as const;

type StepName = (typeof STEPS)[number]['name'];

const index = (name: StepName): number => STEPS.findIndex((s) => s.name === name);

/** The frame the page is prerendered with, and the one reduced motion keeps. */
export const FINAL_STEP: StepName = 'pass';
const FINAL = index(FINAL_STEP);

const PATH = 'src/math.js';

const CODE = ['export function add(a, b) {', '  return a + b;', '}'];

const DIFF: { kind: 'hunk' | 'ctx' | 'add' | 'del'; text: string }[] = [
  { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
  { kind: 'ctx', text: '  export function add(a, b) {' },
  { kind: 'del', text: '-   return a - b;' },
  { kind: 'add', text: '+   return a + b;' },
  { kind: 'ctx', text: '  }' }
];

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

  const at = (name: StepName) => frame >= index(name);
  const applied = at('applied');
  const passed = at('pass');
  const cursor = frame === index('press') ? 'press' : frame === index('point') ? 'button' : 'away';

  const togglePause = () => {
    if (!paused) setStep(FINAL);
    setPaused(!paused);
  };

  return (
    <figure
      ref={figure}
      className="m-0 w-full min-w-0 overflow-hidden rounded-xl border border-border bg-bg"
      aria-labelledby="demo-caption"
      data-step={STEPS[frame]!.name}
      data-playing={playing}
    >
      <div className="flex h-11 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold">Chat</span>
        <span className="text-xs text-fg-muted">chatgpt.com</span>
        {reduced ? null : (
          <button
            type="button"
            className="ml-auto inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs text-fg-muted transition-colors duration-120 hover:bg-bg-muted hover:text-fg"
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
        className="demo-stage grid lg:grid-cols-[minmax(0,1fr)_18.5rem]"
        data-fading={on(frame === index('fade'))}
        aria-hidden="true"
      >
        <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-6 lg:px-10 lg:py-8">
          <p
            className="demo-part m-0 max-w-[85%] self-end rounded-xl bg-bg-muted px-4 py-2.5 text-base"
            data-on={on(at('ask'))}
          >
            Fix the add function in math.js
          </p>

          <div className="text-base leading-normal">
            <p className="demo-part m-0" data-on={on(at('reply'))}>
              <code className="font-mono">add</code> subtracts. Here’s the fixed file:
            </p>
            <p className="demo-part mt-2 mb-0" data-on={on(at('marker'))}>
              <code className="rounded-sm bg-bg-muted px-[5px] py-px text-sm">@@FILE {PATH}@@</code>
            </p>
            <pre className="mt-2 mb-0 overflow-hidden rounded-lg bg-bg-muted px-4 py-3 font-mono text-sm leading-[21px]">
              {CODE.map((line) => (
                <span key={line} className="demo-part demo-line block" data-on={on(at('code'))}>
                  {line}
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
                Modified · <span className="text-success">+1</span>{' '}
                <span className="text-danger">−1</span>
              </span>
            </div>
            <div className="overflow-hidden border-t border-border py-1">
              {DIFF.map((row, i) => (
                <span key={i} className="diff-row" data-kind={row.kind}>
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
                  <span className="btn">Reject</span>
                  <span className="relative">
                    <span
                      className="demo-press btn btn-primary btn-lg"
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
                <span className="btn ml-auto">Undo</span>
              </div>
            </div>
          </div>

          <div
            className="demo-part rounded-lg border border-dashed border-border-strong"
            data-on={on(at('run'))}
          >
            <div className="flex min-h-11 items-center gap-2 px-4 py-2">
              <span className="font-mono text-sm text-fg-subtle">$</span>
              <span className="font-mono text-sm">npm test</span>
              <span className="demo-swap">
                <span className="badge" data-tone="warning" data-on={on(!passed)}>
                  running
                </span>
                <span className="badge" data-tone="success" data-on={on(passed)}>
                  exit 0
                </span>
              </span>
              <span className="demo-part text-xs text-fg-muted" data-on={on(passed)}>
                0.8s
              </span>
            </div>
            <div
              className="demo-part border-t border-dashed border-border-strong px-4 py-2 font-mono text-sm leading-[21px] text-fg-muted"
              data-on={on(passed)}
            >
              <span className="block">
                <span className="text-success">PASS</span> src/math.test.js
              </span>
              <span className="block">Tests: 3 passed, 3 total</span>
            </div>
          </div>
        </div>

        <SidePanel applied={applied} passed={passed} />
      </div>

      <figcaption id="demo-caption" className="sr-only">
        Example: you ask the chat to fix the add function in {PATH}. Its reply has the fixed file,
        and Bridge shows the change as a diff card under it. Nothing is written until you click
        Apply; then the card reads Modified, and the allowed command npm test runs and passes.
      </figcaption>
    </figure>
  );
}

/** The Bridge side panel beside the chat, on wide screens only. */
function SidePanel({ applied, passed }: { applied: boolean; passed: boolean }) {
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
          <p className="m-0 text-base">my-app</p>
          <p className="m-0 truncate font-mono text-xs text-fg-muted">~/code/my-app</p>
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
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            <li className="demo-part flex items-start gap-2" data-on={on(passed)}>
              <span className="dot mt-1.5" data-tone="success" />
              <span className="min-w-0">
                <span className="block font-mono text-sm">npm test</span>
                <span className="block text-xs text-success">Passed · 0.8s</span>
              </span>
            </li>
            <li className="demo-part flex items-start gap-2" data-on={on(applied)}>
              <Icon name="pencil" className="mt-0.5 text-fg-muted" />
              <span className="min-w-0">
                <span className="block truncate font-mono text-sm">{PATH}</span>
                <span className="block text-xs text-fg-muted">Just now · Modified · via chat</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/** The pointer that clicks Apply. */
function Pointer({ at }: { at: 'away' | 'button' | 'press' }) {
  return (
    <svg
      className="demo-cursor"
      data-at={at}
      width="18"
      height="22"
      viewBox="0 0 18 22"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M1.5 1.5v16.2l4.3-4.1 2.7 6.4 3-1.3-2.7-6.2h6z"
        className="fill-fg stroke-bg"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
