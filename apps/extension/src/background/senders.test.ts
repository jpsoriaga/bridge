import { describe, expect, it } from 'vitest';
import { CONTENT_SCRIPT_REQUESTS, EXTENSION_PAGE_REQUESTS, WorkerRequest } from '../messages';
import { classifySender, isAllowed } from './senders';

const ID = 'golkpkmancgpgkpfjggoimedcogghhip';
const ORIGIN = `chrome-extension://${ID}/`;
const tab = { id: 7 } as chrome.tabs.Tab;

const classify = (sender: Partial<chrome.runtime.MessageSender>) =>
  classifySender({ id: ID, ...sender }, ID, ORIGIN);

describe('classifySender', () => {
  it('accepts the side panel as an extension page', () => {
    expect(classify({ url: `${ORIGIN}src/sidepanel/index.html` })).toEqual({
      kind: 'extension-page'
    });
  });

  it('accepts the content script in the top frame of a chatgpt.com tab', () => {
    expect(classify({ url: 'https://chatgpt.com/c/abc-123', tab, frameId: 0 })).toEqual({
      kind: 'chat-tab',
      tabId: 7
    });
  });

  it.each([
    ['another site', 'https://example.com/'],
    ['plain http', 'http://chatgpt.com/'],
    ['a lookalike host', 'https://chatgpt.com.evil.example/'],
    ['a subdomain', 'https://evil.chatgpt.com/'],
    ['chatgpt.com in the query', 'https://evil.example/?https://chatgpt.com/'],
    ['userinfo tricks', 'https://chatgpt.com@evil.example/'],
    ['another port', 'https://chatgpt.com:8443/'],
    ['another extension', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html'],
    ['no URL at all', undefined],
    ['a malformed URL', 'not a url']
  ])('rejects a message from %s', (_label, url) => {
    expect(classify({ url, tab, frameId: 0 })).toBeNull();
  });

  it('rejects a chatgpt.com subframe and a message without a tab', () => {
    expect(classify({ url: 'https://chatgpt.com/', tab, frameId: 3 })).toBeNull();
    expect(classify({ url: 'https://chatgpt.com/' })).toBeNull();
  });

  it('rejects other extensions even from chatgpt.com', () => {
    expect(
      classifySender({ id: 'other', url: 'https://chatgpt.com/', tab, frameId: 0 }, ID, ORIGIN)
    ).toBeNull();
  });
});

describe('isAllowed', () => {
  it('limits chat tabs to the chat requests', () => {
    const chat = { kind: 'chat-tab', tabId: 1 } as const;
    expect(isAllowed(chat, 'chat-write')).toBe(true);
    for (const type of [
      'get-status',
      'pair',
      'unpair',
      'session-start',
      'send-files',
      'get-tree',
      'dev-file'
    ] as const) {
      expect(isAllowed(chat, type)).toBe(false);
    }
  });

  it('keeps chat-only requests away from extension pages, and covers every request', () => {
    const page = { kind: 'extension-page' } as const;
    expect(isAllowed(page, 'session-start')).toBe(true);
    expect(isAllowed(page, 'chat-write')).toBe(false);
    const types = WorkerRequest.options.map((option) => option.shape.type.value);
    for (const type of types) {
      expect(CONTENT_SCRIPT_REQUESTS.has(type) || EXTENSION_PAGE_REQUESTS.has(type)).toBe(true);
    }
  });
});
