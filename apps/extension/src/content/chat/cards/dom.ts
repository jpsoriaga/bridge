// Builds card DOM with createElement and text nodes only. Nothing from the chat is ever
// parsed as HTML: paths, diff lines and file names all go in as text.

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  /** Attributes set with setAttribute. Values are plain strings, never HTML. */
  attrs?: Record<string, string | undefined>;
  onClick?: () => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value !== undefined) element.setAttribute(name, value);
  }
  if (props.onClick) element.addEventListener('click', props.onClick);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return element;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Outline icons, 16px, 1.5px stroke (DESIGN.md "Icons"). Path data is ours, not the chat's. */
const ICONS = {
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4'],
  check: ['M20 6 9 17l-5-5'],
  chevron: ['m6 9 6 6 6-6'],
  alert: [
    'M12 9v4',
    'M12 17h.01',
    'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'
  ],
  trash: [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'
  ],
  arrow: ['M5 12h14', 'm12 5 7 7-7 7'],
  copy: [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z',
    'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'
  ],
  terminal: ['m4 17 6-6-6-6', 'M12 19h8']
} as const;

export function icon(name: keyof typeof ICONS, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.25');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export const formatCount = (n: number) => n.toLocaleString('en-US');

/** "07:50 PM": when a card's change landed. */
export const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "1.2 KB", "340 B": a file's size on a card. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An icon button that copies `text` (a path) and says so. */
export function copyButton(text: string, label = 'Copy path'): HTMLButtonElement {
  const button = h(
    'button',
    {
      class: 'icon-btn',
      attrs: { type: 'button', 'aria-label': label, title: label, 'data-focus': 'copy' }
    },
    icon('copy')
  );
  button.addEventListener('click', () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        button.setAttribute('aria-label', 'Copied');
        button.title = 'Copied';
        button.dataset.copied = 'true';
        setTimeout(() => {
          button.setAttribute('aria-label', label);
          button.title = label;
          delete button.dataset.copied;
        }, 1500);
      })
      .catch(() => undefined);
  });
  return button;
}

/**
 * Replaces a card's content, keeping keyboard focus: an element with the same
 * `data-focus` gets it back, else the first enabled button, so a keyboard user isn't
 * dropped to the top of the page when the card redraws (Apply becomes Undo, say).
 */
export function renderCard(root: ShadowRoot, card: HTMLElement): void {
  const active = root.activeElement as HTMLElement | null;
  const focusKey = active?.dataset.focus ?? (active ? 'any' : null);
  const style = root.querySelector('style');
  root.replaceChildren(...(style ? [style] : []), card);
  if (focusKey === null) return;
  const target =
    (focusKey !== 'any' &&
      root.querySelector<HTMLElement>(`[data-focus="${focusKey}"]:not(:disabled)`)) ||
    root.querySelector<HTMLElement>('button:not(:disabled)');
  target?.focus();
}
