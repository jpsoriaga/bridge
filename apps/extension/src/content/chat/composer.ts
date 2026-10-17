import type { InsertResult } from '../../messages';
import { findComposer } from './selectors';

/**
 * Puts text into the chat's composer at the caret, the way a paste would. It never
 * presses send: the user reads what's there and sends it themselves.
 *
 * ProseMirror handles a synthetic `paste` carrying `text/plain` like a real one, so that's
 * tried first. If nothing changed, `execCommand('insertText')` is the fallback. A plain
 * <textarea> (older layouts) gets its value set and an `input` event.
 */
export function insertIntoComposer(text: string, doc: Document = document): InsertResult {
  const composer = findComposer(doc);
  if (!composer) return { ok: false, error: 'no-composer' };

  if (composer instanceof HTMLTextAreaElement) {
    const start = composer.selectionStart ?? composer.value.length;
    const end = composer.selectionEnd ?? start;
    // React tracks the value through the prototype setter, so go through it.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    const next = composer.value.slice(0, start) + text + composer.value.slice(end);
    if (setter) setter.call(composer, next);
    else composer.value = next;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.focus();
    return { ok: true, method: 'textarea', chars: text.length };
  }

  composer.focus();
  const before = composer.textContent ?? '';
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const paste = new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true
  });
  composer.dispatchEvent(paste);
  // Handled. The text may be in the composer, or (when long) the page may have made it an
  // attachment. Either way, inserting again would duplicate it.
  if (paste.defaultPrevented) return { ok: true, method: 'paste', chars: text.length };

  // Deprecated, but still the one way to type into a contenteditable as the user would.
  const inserted = doc.execCommand('insertText', false, text);
  if (inserted && (composer.textContent ?? '') !== before) {
    return { ok: true, method: 'insert-text', chars: text.length };
  }
  return { ok: false, error: 'not-inserted' };
}
