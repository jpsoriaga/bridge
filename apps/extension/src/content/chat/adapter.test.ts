// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { interruptionOf, parseChat } from '@bridge/shared';
import { messageToText } from './adapter';
import {
  assistantMessages,
  checkLayout,
  composerAttachments,
  composerBusy,
  findContinueButton,
  findStopButton,
  isMessageComplete,
  messageIdOf,
  replyError,
  limitResetTime,
  replyStatus,
  usageLimit,
  userMessageCount
} from './selectors';

const FIXTURES = join(__dirname, '../../../fixtures/chatgpt');

function load(name: string): void {
  document.body.innerHTML = readFileSync(join(FIXTURES, name), 'utf8');
}

function parseOnly(): ReturnType<typeof parseChat> & { codeBlocks: Element[] } {
  const [message] = assistantMessages(document);
  if (!message) throw new Error('no assistant message');
  const { text, codeBlocks } = messageToText(message);
  return { ...parseChat(text), codeBlocks };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('messageToText on saved chat pages', () => {
  it('reads a single edit from inline-code marker and code block', () => {
    load('single-edit.html');
    const [message] = assistantMessages(document);
    expect(message && isMessageComplete(message)).toBe(true);
    expect(message && messageIdOf(message, 0)).toBe('a1b2c3d4-0001-4000-8000-000000000001');

    const { edits, reads, codeBlocks } = parseOnly();
    expect(reads).toEqual([]);
    expect(edits).toEqual([
      {
        path: 'src/greet.ts',
        content: 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
        suspectedPartial: false,
        fence: 0
      }
    ]);
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]?.localName).toBe('pre');
  });

  it('reads multiple edits, skips the shell block and restores __init__', () => {
    load('multiple-edits.html');
    const { edits, reads, codeBlocks } = parseOnly();
    expect(edits.map(({ path, fence }) => ({ path, fence }))).toEqual([
      { path: 'pkg/__init__.py', fence: 1 },
      { path: 'pkg/client.py', fence: 2 }
    ]);
    expect(edits[0]?.content).toBe('from .client import Client\n\n__all__ = ["Client"]\n');
    expect(edits[1]?.content).toContain('class Client:\n    def get(self, url):\n');
    expect(reads).toEqual(['pyproject.toml', 'tests/test_client.py']);
    expect(codeBlocks).toHaveLength(3);
  });

  it('does not treat a still-streaming message as complete', () => {
    load('streaming.html');
    const [message] = assistantMessages(document);
    expect(message && isMessageComplete(message)).toBe(false);
  });

  it('marks it complete once the indicator goes and the action buttons appear', () => {
    load('streaming.html');
    const [message] = assistantMessages(document);
    if (!message) throw new Error('no message');
    document.querySelector('.result-streaming')?.classList.remove('result-streaming');
    document.querySelector('[data-testid="stop-button"]')?.remove();
    expect(isMessageComplete(message)).toBe(true);
    const turn = message.closest('article');
    const actions = document.createElement('button');
    actions.setAttribute('data-testid', 'copy-turn-action-button');
    turn?.append(actions);
    expect(isMessageComplete(message)).toBe(true);
  });

  it('reads code, not the code block header, and keeps an inner fence', () => {
    load('code-header.html');
    const { edits } = parseOnly();
    expect(edits).toHaveLength(1);
    const content = edits[0]?.content ?? '';
    expect(content.startsWith('# Demo\n')).toBe(true);
    expect(content).not.toMatch(/markdown|Copy code|Edit/);
    expect(content).toContain('```sh\nnpm install demo\n```\n');
    expect(edits[0]?.suspectedPartial).toBe(true);
  });

  it('never parses a user message, even one with @@FILE in it', () => {
    load('user-message.html');
    expect(assistantMessages(document)).toEqual([]);
    // Even if it were read, a user message is plain text with no <pre>, so its fences are
    // escaped and nothing in it, @@CONTEXT or @@FILE, becomes an edit.
    const user = document.querySelector('[data-message-author-role="user"]');
    if (!user) throw new Error('no user message');
    const { text, codeBlocks } = messageToText(user);
    expect(codeBlocks).toEqual([]);
    expect(parseChat(text)).toMatchObject({
      edits: [],
      reads: [],
      runs: [],
      deletes: [],
      renames: []
    });
  });

  it('skips Bridge cards injected into the message', () => {
    load('single-edit.html');
    const pre = document.querySelector('pre');
    const host = document.createElement('div');
    host.setAttribute('data-bridge-host', 'card');
    host.textContent = '@@FILE injected.ts@@\n```\nx\n```';
    pre?.after(host);
    expect(parseOnly().edits.map((e) => e.path)).toEqual(['src/greet.ts']);
  });

  it('escapes prose that looks like a fence so code block numbering holds', () => {
    document.body.innerHTML = `<div data-message-author-role="assistant"><div class="markdown">
      <p>\`\`\`not a fence</p><p><code>@@FILE a.ts@@</code></p><pre><code>a</code></pre></div></div>`;
    const { edits } = parseOnly();
    expect(edits).toEqual([{ path: 'a.ts', content: 'a\n', suspectedPartial: false, fence: 0 }]);
  });
});

describe('checkLayout', () => {
  it('is ok on a chat page with messages and a composer', () => {
    load('single-edit.html');
    expect(checkLayout()).toBe('ok');
  });

  it('is unknown when the composer or messages cannot be found', () => {
    load('single-edit.html');
    document.querySelector('#prompt-textarea')?.remove();
    expect(checkLayout()).toBe('unknown');

    load('single-edit.html');
    document
      .querySelectorAll('[data-message-author-role]')
      .forEach((m) => m.removeAttribute('data-message-author-role'));
    expect(checkLayout()).toBe('unknown');
  });
});

describe('the newer layout (DIL renderer)', () => {
  it('finds assistant replies, their ids, and which have finished', () => {
    load('dil-renderer.html');
    const messages = assistantMessages(document);
    expect(messages).toHaveLength(2);
    expect(messageIdOf(messages[0]!, 0)).toBe('8bc7f95c-33b4-40f6-986b-c80e20711fac');
    expect(messageIdOf(messages[1]!, 1)).toBe('9cd8a06d-44c5-41a7-a97c-d91e21822fbd');
    expect(isMessageComplete(messages[0]!)).toBe(true);
    expect(isMessageComplete(messages[1]!)).toBe(false);
  });

  it('reads FILE, READ and RUN markers, skipping the code block header', () => {
    load('dil-renderer.html');
    const { edits, reads, runs, codeBlocks } = parseOnly();
    expect(edits).toEqual([
      {
        path: 'src/App.tsx',
        content: 'export default function App() {\n  return <h1>Hello Bridge</h1>;\n}\n',
        suspectedPartial: false,
        fence: 0
      }
    ]);
    expect(reads).toEqual(['package.json']);
    expect(runs).toEqual(['npm run build']);
    // The card goes after the whole code block, not inside its scrolling viewer.
    expect(codeBlocks[0]?.getAttribute('data-code-block')).toBe('true');
  });

  it('counts user turns, never parses them, and reads the layout as ok', () => {
    load('dil-renderer.html');
    expect(userMessageCount()).toBe(1);
    expect(checkLayout()).toBe('ok');
  });
});

describe('replies cut off, and the buttons to catch up after sleep', () => {
  it('sees a reply with a network error in its turn as cut off, and its last block as unfinished', () => {
    load('interrupted.html');
    const [message] = assistantMessages(document);
    if (!message) throw new Error('no message');
    expect(replyError(message)).toMatch(/^Network error/);
    expect(replyStatus(message, document, true)).toBe('interrupted');
    const parse = parseOnly();
    expect(parse.edits.map((e) => e.path)).toEqual(['src/one.ts', 'src/two.ts']);
    expect(interruptionOf(parse)).toEqual({ marker: '@@FILE src/one.ts@@', cutOff: 'src/two.ts' });
  });

  it('ignores error words inside the reply’s own text', () => {
    load('single-edit.html');
    const [message] = assistantMessages(document);
    if (!message) throw new Error('no message');
    message.querySelector('p')!.textContent = 'Something went wrong in your code: a network error.';
    expect(replyError(message)).toBeNull();
    expect(replyStatus(message, document, true)).toBe('complete');
  });

  it('tells streaming from finished, and finds the stop button', () => {
    load('streaming.html');
    const [message] = assistantMessages(document);
    if (!message) throw new Error('no message');
    expect(replyStatus(message, document, true)).toBe('streaming');
    expect(findStopButton()?.getAttribute('data-testid')).toBe('stop-button');
    // The newer layout turns the composer's submit button into Stop.
    document.querySelector('[data-testid="stop-button"]')!.remove();
    const submit = document.createElement('button');
    submit.id = 'composer-submit-button';
    submit.setAttribute('aria-label', 'Stop streaming');
    document.querySelector('form')!.append(submit);
    expect(findStopButton()).toBe(submit);
  });

  it('finds the page’s Continue generating by test id or by its text, and calls the reply cut off', () => {
    load('single-edit.html');
    const [message] = assistantMessages(document);
    if (!message) throw new Error('no message');
    expect(findContinueButton()).toBeNull();
    const button = document.createElement('button');
    button.textContent = ' Continue generating ';
    document.querySelector('form')!.append(button);
    expect(findContinueButton()).toBe(button);
    expect(replyStatus(message, document, true)).toBe('interrupted');
    // Only the newest reply is cut off by it.
    expect(replyStatus(message, document, false)).toBe('complete');
    button.textContent = 'Continue';
    expect(findContinueButton()).toBeNull();
    button.setAttribute('data-testid', 'continue-generating-button');
    expect(findContinueButton()).toBe(button);
  });

  it('calls a page-level network banner a cut, but not a usage limit', () => {
    load('single-edit.html');
    const [message] = assistantMessages(document);
    if (!message) throw new Error('no message');
    const banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.textContent = 'Network error';
    document.body.append(banner);
    expect(replyStatus(message, document, true)).toBe('interrupted');
    banner.textContent = 'You’ve reached your usage limit.';
    expect(replyStatus(message, document, true)).toBe('complete');
  });
});

describe('the composer’s attachments and usage limits', () => {
  const form = () => document.querySelector('form')!;

  it('sees a "Pasted text" chip, busy while it shows progress or says it’s processing', () => {
    load('single-edit.html');
    expect(composerAttachments()).toEqual([]);
    expect(composerBusy()).toBe(false);
    form().insertAdjacentHTML(
      'afterbegin',
      '<div data-testid="file-tile"><span>Pasted text</span><div role="progressbar"></div><button aria-label="Remove file 1: Pasted text"></button></div>'
    );
    expect(composerAttachments()).toHaveLength(1);
    expect(composerBusy()).toBe(true);
    form().querySelector('[role="progressbar"]')!.remove();
    expect(composerBusy()).toBe(false);
    form().querySelector('[data-testid="file-tile"] span')!.textContent = 'Processing…';
    expect(composerBusy()).toBe(true);
  });

  it('finds a limit that was reached, and when it resets', () => {
    load('single-edit.html');
    expect(usageLimit()).toBeNull();
    const banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.textContent = 'You’ve reached your message limit. It resets at 4:30 PM.';
    document.body.append(banner);
    expect(usageLimit()).toEqual({ reached: true, resetsAt: 'at 4:30 PM' });
    banner.textContent =
      'You’ve hit the Free plan limit for GPT. Responses will use another model until it resets tomorrow.';
    expect(usageLimit()).toEqual({ reached: true, resetsAt: 'tomorrow' });
  });

  it('tells the "usage remaining" warning from a reached limit', () => {
    load('single-edit.html');
    const warning = document.createElement('div');
    warning.setAttribute('data-testid', 'usage-limit-banner');
    warning.textContent = '3 messages remaining. Usage resets after 9:15 pm.';
    document.body.append(warning);
    expect(usageLimit()).toEqual({ reached: false, resetsAt: 'at 9:15 pm' });
  });

  it('never reads a limit from a message’s own text', () => {
    load('single-edit.html');
    const [message] = assistantMessages(document);
    message!.insertAdjacentHTML(
      'beforeend',
      '<div role="status">You’ve reached your usage limit (in the test fixture).</div>'
    );
    expect(usageLimit()).toBeNull();
  });

  it('reads the reset time in the page’s words', () => {
    expect(limitResetTime('Your limit resets at 16:05.')).toBe('at 16:05');
    expect(limitResetTime('Try again in 3 hours.')).toBe('in 3 hours');
    expect(limitResetTime('Upgrade for more.')).toBeNull();
    expect(limitResetTime('3 messages remaining')).toBeNull();
  });
});
