import { FORMAT_REMINDER, type FormatIssue, type FormatIssueKind } from '@bridge/shared';
import { insertIntoComposer } from '../composer';
import { h, icon, renderCard } from './dom';
import { createHost } from './host';

/** Issues listed on the card before "and N more". */
const SHOWN_ISSUES = 3;

const ISSUE_TEXT: Record<FormatIssueKind, (text: string) => string> = {
  'bad-marker': (text) => `Not a Bridge marker: ${text}`,
  'no-marker': (text) => `A code block under “${text}” has no @@FILE marker.`,
  'no-block': (text) => `No code block after ${text}`,
  placeholder: (text) => `${text} has a placeholder like “rest unchanged”.`
};

/** One line per issue, for the card. */
export function issueLines(issues: readonly FormatIssue[]): string[] {
  const lines = issues.slice(0, SHOWN_ISSUES).map((issue) => ISSUE_TEXT[issue.kind](issue.text));
  if (issues.length > SHOWN_ISSUES) lines.push(`And ${issues.length - SHOWN_ISSUES} more.`);
  return lines;
}

/**
 * Under a reply that looks meant for Bridge but missed its format (`FormatIssue`): what
 * Bridge couldn't read, and **Send format reminder**, which puts `FORMAT_REMINDER` in the
 * composer without sending it. In Full auto the loop sends the reminder itself, and the card
 * says so.
 */
export class FormatCard {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private disabled = false;
  /** The reminder went into the composer from this card. */
  private inserted = false;
  /** Full auto sent the reminder. */
  private autoSent = false;
  private error: string | null = null;

  constructor(readonly issues: readonly FormatIssue[]) {
    ({ host: this.host, root: this.root } = createHost('format-card'));
    this.render();
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.render();
  }

  markAutoSent(): void {
    this.autoSent = true;
    this.render();
  }

  insert(): void {
    const result = insertIntoComposer(FORMAT_REMINDER);
    if (!result.ok) {
      this.error =
        result.error === 'no-composer'
          ? 'Bridge can’t find the message box on this page.'
          : 'Bridge couldn’t insert the reminder. Click in the message box and try again.';
    } else {
      this.inserted = true;
      this.error = null;
    }
    this.render();
  }

  private render(): void {
    const title = 'The chat didn’t use Bridge’s format';
    const hint = this.disabled
      ? 'Session ended.'
      : this.autoSent
        ? 'Full auto sent a format reminder.'
        : this.inserted
          ? 'The reminder is in the message box. Press send.'
          : 'Bridge ignored what it couldn’t read. A reminder asks the chat to redo the reply.';
    const button = h(
      'button',
      {
        class: 'btn btn-primary',
        attrs: { type: 'button', 'data-focus': 'remind' },
        onClick: () => this.insert()
      },
      this.inserted || this.autoSent ? 'Insert again' : 'Send format reminder'
    );
    button.disabled = this.disabled;
    const card = h(
      'div',
      { class: 'card', attrs: { 'data-kind': 'format', role: 'group', 'aria-label': title } },
      h('div', { class: 'header' }, icon('alert'), h('span', { class: 'title' }, title)),
      h(
        'ul',
        { class: 'files' },
        ...issueLines(this.issues).map((line) => h('li', { class: 'issue' }, line))
      ),
      this.error
        ? h('p', { class: 'message', attrs: { 'data-tone': 'danger', role: 'alert' } }, this.error)
        : null,
      h(
        'div',
        { class: 'footer' },
        h(
          'p',
          {
            class: 'hint',
            attrs: { 'data-tone': this.inserted || this.autoSent ? undefined : 'warning' }
          },
          hint
        ),
        button
      )
    );
    renderCard(this.root, card);
  }
}
