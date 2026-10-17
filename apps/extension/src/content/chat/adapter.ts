import { pickFence } from '@bridge/shared';
import { BRIDGE_HOST_ATTRIBUTE, messageBody } from './selectors';

export interface MessageText {
  /** The message as markdown-ish text, ready for `parseChat`. */
  text: string;
  /**
   * Every code block in order, where its card goes: the layout's code block wrapper
   * (`[data-code-block]`) if it has one, else the `<pre>`. `ParsedEdit.fence` indexes into this.
   */
  codeBlocks: Element[];
}

const SKIP = new Set(['button', 'svg', 'style', 'script', 'template', 'noscript', 'img']);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'hr',
  'details',
  'summary',
  'figure'
]);

/** Marks what the page's own Copy leaves out (`exclude`): headers, buttons. */
const COPY_ATTRIBUTE = 'data-markdown-copy';
/** The newer layout's code block wrapper, around its header and its `<pre>`. */
const CODE_BLOCK = '[data-code-block]';

/** A line of prose that would read as a fence. Escaped so only real code blocks count. */
const FENCE_LIKE = /^\s*(?:`{3,}|~{3,})/;

class Writer {
  readonly lines: string[] = [];
  private current = '';

  text(value: string): void {
    const parts = value.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) this.newline();
      this.current += part;
    });
  }

  newline(): void {
    const line = this.current.trim() === '' ? '' : this.current;
    this.current = '';
    // Indentation between tags turns into blank lines. Keep at most one in a row.
    if (line === '' && (this.lines.length === 0 || this.lines[this.lines.length - 1] === ''))
      return;
    this.lines.push(FENCE_LIKE.test(line) ? `\\${line}` : line);
  }

  /** Starts a new paragraph: ends the current line and leaves one blank line. */
  block(): void {
    if (this.current.trim() !== '') this.newline();
    this.current = '';
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.lines.push('');
  }

  /** Lines written as they are, in their own paragraph. */
  raw(lines: string[]): void {
    this.block();
    this.lines.push(...lines);
    this.block();
  }

  done(): string {
    this.block();
    return this.lines.join('\n').trim();
  }
}

function codeBlock(pre: Element): string[] {
  // The header ("typescript", Copy) sits inside <pre> next to <code>, so read <code> only.
  const code = pre.querySelector('code');
  let content = (code ?? pre).textContent ?? '';
  if (content.endsWith('\n')) content = content.slice(0, -1);
  const language = /(?:^|\s)language-([\w+#.-]{1,32})/.exec(code?.className ?? '')?.[1] ?? '';
  const fence = pickFence(content);
  return content === ''
    ? [fence + language, fence]
    : [fence + language, ...content.split('\n'), fence];
}

function walk(node: Node, out: Writer, codeBlocks: Element[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.text(node.textContent ?? '');
    return;
  }
  if (!(node instanceof Element)) return;
  const tag = node.localName;
  if (SKIP.has(tag) || node.hasAttribute(BRIDGE_HOST_ATTRIBUTE)) return;
  // The page's own chrome inside a message (a code block's "TypeScript" header and
  // buttons), which its Copy leaves out too. Read, it would split a marker from its fence.
  if (node.getAttribute(COPY_ATTRIBUTE) === 'exclude') return;

  const children = () => node.childNodes.forEach((child) => walk(child, out, codeBlocks));
  switch (tag) {
    case 'pre':
      // The card goes after the whole code block, not inside its scrolling viewer.
      codeBlocks.push(node.closest(CODE_BLOCK) ?? node);
      out.raw(codeBlock(node));
      return;
    case 'br':
      out.newline();
      return;
    case 'code':
      // Inline code. Kept in backticks so the parser sees `@@FILE path@@` as written.
      out.text(`\`${node.textContent ?? ''}\``);
      return;
    case 'strong':
    case 'b':
      // Markdown turns __init__ into bold "init". Put the underscores back: in a path they
      // are far more likely than **.
      out.text('__');
      children();
      out.text('__');
      return;
    case 'em':
    case 'i':
      out.text('_');
      children();
      out.text('_');
      return;
    case 'li':
      out.block();
      out.text('- ');
      children();
      out.block();
      return;
    case 'td':
    case 'th':
      children();
      out.text(' | ');
      return;
  }
  if (BLOCK.has(tag)) {
    out.block();
    children();
    out.block();
    return;
  }
  children();
}

/**
 * Turns a rendered message into text the shared parser reads: paragraphs become lines,
 * and each `<pre>` becomes one fenced block of its `<code>` text, with a fence longer than
 * any backtick run inside it. No regex ever runs on the page's HTML.
 */
export function messageToText(message: Element): MessageText {
  const out = new Writer();
  const codeBlocks: Element[] = [];
  walk(messageBody(message), out, codeBlocks);
  return { text: out.done(), codeBlocks };
}
