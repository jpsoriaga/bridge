// Helpers shared by the chat e2e scripts: a stand-in chatgpt.com page, assistant turns in
// its markup, and reading and clicking cards inside their closed shadow roots over CDP.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib.cjs');

const step = (m) => console.log('•', m);
const FIXTURES = path.join(ROOT, 'apps/extension/fixtures/chatgpt');

/** The `<article>` turn from a fixture, with its message id replaced if asked. */
function turn(name, messageId) {
  const html = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const article = html.slice(html.indexOf('<article'), html.lastIndexOf('</article>') + 10);
  return messageId
    ? article.replace(/data-message-id="[^"]+"/, `data-message-id="${messageId}"`)
    : article;
}

// A stand-in for the chat page: <main> as a centred column like the real one (the Bridge
// chip sits in the margin beside it), a contenteditable composer whose paste handler
// behaves like ProseMirror's (takes text/plain, prevents the default), and a send button
// that turns the composer's text into a user turn, as the page does.
const SHELL = `<!doctype html><html class="light"><head><meta charset="utf-8"><title>Chat</title>
<style>main { max-width: 760px; margin: 0 auto; }</style></head>
<body><main class="relative h-full w-full flex-1"></main>
<form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p><br></p></div>
<button id="send" data-testid="send-button" type="button" aria-label="Send prompt">Send</button></form>
<script>
  const composer = document.getElementById('prompt-textarea');
  composer.addEventListener('paste', (event) => {
    event.preventDefault();
    composer.textContent += event.clipboardData.getData('text/plain');
  });
  document.querySelector('form').addEventListener('submit', () => { window.__submitted = true; });
  document.getElementById('send').addEventListener('click', () => {
    const text = composer.textContent;
    if (!text.trim()) return;
    window.__sends = (window.__sends || []).concat([{ text, at: Date.now() }]);
    composer.textContent = '';
    const main = document.querySelector('main');
    const n = main.querySelectorAll('[data-message-author-role="user"]').length;
    main.insertAdjacentHTML('beforeend', '<article data-testid="conversation-turn-u' + n + '"><div data-message-author-role="user" data-message-id="u-' + n + '"><div class="whitespace-pre-wrap"></div></div></article>');
    main.lastElementChild.querySelector('.whitespace-pre-wrap').textContent = text;
  });
</script></body></html>`;

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A finished assistant turn in the page's markup, built from markdown-ish parts. */
function assistantTurn(messageId, parts) {
  const body = parts
    .map((part) =>
      part.file
        ? `<p><code>@@FILE ${part.file}@@</code></p><pre><code>${escapeHtml(part.content)}</code></pre>`
        : part.run
          ? `<p><code>@@RUN ${part.run}@@</code></p>`
          : part.delete
            ? `<p><code>@@DELETE ${escapeHtml(part.delete)}@@</code></p>`
            : part.rename
              ? `<p><code>@@RENAME ${escapeHtml(part.rename)}@@</code></p>`
              : `<p>${escapeHtml(part.text)}</p>`
    )
    .join('');
  return `<article data-testid="conversation-turn-${messageId}"><div data-message-author-role="assistant" data-message-id="${messageId}"><div class="markdown prose">${body}</div></div><div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div></article>`;
}

/** Every node under the page, closed shadow roots included, from CDP. */
async function piercedTree(cdp) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  return root;
}

function* walk(node) {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
  for (const shadow of node.shadowRoots ?? []) yield* walk(shadow);
  if (node.contentDocument) yield* walk(node.contentDocument);
}

const attr = (node, name) => {
  const a = node.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
};
function* textNodes(node) {
  if (node.nodeName === 'STYLE') return;
  if (node.nodeType === 3) yield node.nodeValue;
  for (const child of node.children ?? []) yield* textNodes(child);
  for (const shadow of node.shadowRoots ?? []) yield* textNodes(shadow);
}
const textOf = (node) => [...textNodes(node)].join(' ');

/** Card hosts of one kind, in page order. */
async function hosts(cdp, kind) {
  const root = await piercedTree(cdp);
  return [...walk(root)].filter(
    (n) => n.nodeName === 'DIV' && attr(n, 'data-bridge-host') === kind
  );
}

async function cardText(cdp, kind, index) {
  const host = (await hosts(cdp, kind))[index];
  if (!host) throw new Error(`no ${kind} #${index}`);
  return textOf(host).replace(/\s+/g, ' ').trim();
}

/** Clicks a button inside a card (closed shadow root) with a trusted mouse click. */
async function clickInCard(page, cdp, kind, index, label) {
  const host = (await hosts(cdp, kind))[index];
  if (!host) throw new Error(`no ${kind} #${index}`);
  const button = [...walk(host)].find((n) => n.nodeName === 'BUTTON' && textOf(n).trim() === label);
  if (!button) throw new Error(`no "${label}" in ${kind} #${index}: ${textOf(host)}`);
  // Centre it, so nothing fixed to the page's edges (the Bridge chip) sits on top of it.
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: button.backendNodeId });
  await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function () { this.scrollIntoView({ block: "center" }); }'
  });
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: button.backendNodeId });
  const [x1, y1, , , x3, y3] = model.content;
  const [x, y] = [(x1 + x3) / 2, (y1 + y3) / 2];
  if (process.env.E2E_DEBUG) {
    try {
      const hit = await cdp.send('DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
        includeUserAgentShadowDOM: true
      });
      const { node } = await cdp.send('DOM.describeNode', { backendNodeId: hit.backendNodeId });
      console.error(
        'click',
        label,
        'at',
        x,
        y,
        '→',
        node.nodeName,
        JSON.stringify(node.attributes),
        'button',
        button.backendNodeId,
        'hit',
        hit.backendNodeId
      );
    } catch (e) {
      console.error('click', label, 'at', x, y, '→', e.message);
    }
  }
  await page.mouse.click(x, y);
}

/**
 * Every card on the page (not the chip or the notice): each action is a `card-btn`, and
 * all of a card's actions have the same rendered height, 32px. Returns the kinds checked
 * with their button labels. Hidden buttons (a collapsed card) have no box and are skipped.
 */
async function checkCardButtons(cdp) {
  const root = await piercedTree(cdp);
  const checked = {};
  for (const host of [...walk(root)]) {
    const kind = host.nodeName === 'DIV' ? attr(host, 'data-bridge-host') : undefined;
    if (!kind || kind === 'loop-chip' || kind === 'page-notice') continue;
    const heights = [];
    for (const node of walk(host)) {
      if (node.nodeName !== 'BUTTON') continue;
      const cls = attr(node, 'class') ?? '';
      if (/(^|\s)btn(\s|$)/.test(cls)) throw new Error(`${kind}: a .btn button: ${textOf(node)}`);
      if (cls !== 'card-btn') continue;
      let box;
      try {
        ({ model: box } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }));
      } catch {
        continue;
      }
      heights.push([textOf(node).trim(), box.border[5] - box.border[1]]);
    }
    if (heights.some(([, h]) => Math.abs(h - 32) > 0.5)) {
      throw new Error(`${kind}: card buttons differ in height: ${JSON.stringify(heights)}`);
    }
    if (heights.length > 0) (checked[kind] ??= new Set()).add(heights.map(([l]) => l).join(' + '));
  }
  return Object.fromEntries(Object.entries(checked).map(([k, v]) => [k, [...v]]));
}

async function waitFor(what, fn, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : last}`);
}

/**
 * The side panel's view of the chat in its window's active tab, as the worker pushes it.
 * Waits for a session unless `anySession`.
 */
function panelChat(panel, anySession = false) {
  return panel.evaluate(
    (any) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'sidepanel' });
        // The first push comes before the panel says which window it's in: no tab yet.
        port.onMessage.addListener((m) => {
          if (m.type !== 'status' || !m.chat.tab || (!any && !m.chat.session)) return;
          port.disconnect();
          resolve(m.chat);
        });
        void chrome.windows
          .getCurrent()
          .then(({ id }) => port.postMessage({ type: 'panel-window', windowId: id }));
      }),
    anySession
  );
}

module.exports = {
  step,
  FIXTURES,
  SHELL,
  turn,
  escapeHtml,
  assistantTurn,
  hosts,
  cardText,
  clickInCard,
  checkCardButtons,
  waitFor,
  panelChat
};
