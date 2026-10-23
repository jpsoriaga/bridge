import { useState } from 'react';
import { Icon } from './Icon';

// The hero's picture: a chat reply with a Bridge diff card under it, drawn like the real card
// (DESIGN.md "Diff card"). Apply, Reject and Undo work on the picture only.

type CardState = 'pending' | 'applied' | 'rejected';

const PATH = 'src/components/Header.tsx';

const ROWS: { kind: 'hunk' | 'ctx' | 'add' | 'del'; text: string }[] = [
  { kind: 'hunk', text: '@@ -1,8 +1,12 @@' },
  { kind: 'ctx', text: "  import { Logo } from './Logo';" },
  { kind: 'add', text: "+ import { useTheme } from '../hooks/useTheme';" },
  { kind: 'ctx', text: '' },
  { kind: 'ctx', text: '  export function Header() {' },
  { kind: 'add', text: '+   const { theme, toggle } = useTheme();' },
  { kind: 'ctx', text: '    return (' },
  { kind: 'del', text: '-     <header className="bar">' },
  { kind: 'add', text: '+     <header className="bar" data-theme={theme}>' },
  { kind: 'ctx', text: '        <Logo />' },
  { kind: 'add', text: '+       <button onClick={toggle}>Theme</button>' },
  { kind: 'ctx', text: '      </header>' }
];

export function ChatDemo() {
  const [state, setState] = useState<CardState>('pending');
  const [open, setOpen] = useState(true);

  return (
    <figure
      className="m-0 w-full min-w-0 rounded-xl border border-border bg-bg"
      aria-label="Example: a chat reply with a Bridge diff card under it"
    >
      <div className="flex h-11 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold">Chat</span>
        <span className="text-xs text-fg-muted">chatgpt.com</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
          <span className="dot" data-tone="success" />
          Session active
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <p className="m-0 max-w-[85%] self-end rounded-xl bg-bg-muted px-4 py-2.5 text-base">
          Add a theme toggle to the header.
        </p>

        <div className="text-base leading-normal">
          <p className="m-0">
            Here’s the updated header. It reads the theme from a hook and adds a button:
          </p>
          <p className="mt-2 mb-0">
            <code className="rounded-sm bg-bg-muted px-[5px] py-px text-sm">@@FILE {PATH}@@</code>
          </p>
        </div>

        <div
          role="group"
          aria-label={`Diff card for ${PATH}`}
          className={`overflow-hidden rounded-lg border bg-bg ${
            state === 'pending' ? 'border-border-strong' : 'border-border'
          }`}
        >
          {state === 'pending' ? (
            <>
              <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2">
                <Icon name="file" className="text-fg-muted" />
                <span className="min-w-0 truncate font-mono text-sm">{PATH}</span>
                <span className="badge">modified</span>
                <span className="text-xs text-fg-muted">
                  Modified · <span className="text-success">+4</span>{' '}
                  <span className="text-danger">−1</span>
                </span>
                <button
                  type="button"
                  className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-xs text-fg-muted hover:text-fg"
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                >
                  {open ? 'Hide diff' : 'Show diff'}
                  <Icon name="chevron" size={14} className={open ? 'rotate-180' : ''} />
                </button>
              </div>
              {open ? (
                <div
                  className="overflow-x-auto border-t border-border py-1"
                  tabIndex={0}
                  aria-label="Diff"
                >
                  {ROWS.map((row, i) => (
                    <span key={i} className="diff-row" data-kind={row.kind}>
                      {row.text || ' '}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 border-t border-border bg-bg-hover px-4 py-3">
                <p className="m-0 flex min-w-0 items-center gap-2 text-xs text-fg-muted">
                  <span className="font-medium text-fg">Manual</span>
                  <span className="h-3 w-px bg-border-strong" aria-hidden="true" />
                  Review before applying.
                </p>
                <div className="ml-auto flex gap-2">
                  <button type="button" className="btn" onClick={() => setState('rejected')}>
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-lg"
                    onClick={() => setState('applied')}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </>
          ) : state === 'applied' ? (
            <div
              className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2"
              aria-live="polite"
            >
              <Icon name="file" className="text-fg-muted" />
              <span className="min-w-0 truncate font-mono text-sm">{PATH}</span>
              <span className="text-xs text-fg-muted">+4 −1</span>
              <span className="text-sm font-medium">Modified</span>
              <span className="text-xs text-fg-muted tabular-nums">just now</span>
              <button type="button" className="btn ml-auto" onClick={() => setState('pending')}>
                Undo
              </button>
            </div>
          ) : (
            <div
              className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2"
              aria-live="polite"
            >
              <Icon name="file" className="text-fg-subtle" />
              <span className="min-w-0 truncate font-mono text-sm text-fg-subtle line-through">
                {PATH}
              </span>
              <span className="text-sm text-fg-muted">Rejected</span>
              <button
                type="button"
                className="ml-auto cursor-pointer rounded-sm border-0 bg-transparent p-0 text-xs text-fg-muted hover:text-fg"
                onClick={() => setState('pending')}
              >
                Show it again
              </button>
            </div>
          )}
        </div>
      </div>
      <figcaption className="sr-only">
        The chat suggests a change to {PATH}. Bridge shows it as a diff, and nothing is written
        until you click Apply.
      </figcaption>
    </figure>
  );
}
