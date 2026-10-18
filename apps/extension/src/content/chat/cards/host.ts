import tokens from '@bridge/shared/tokens.css?inline';
import { CARD_FONTS } from '../../../fonts';
import { BRIDGE_HOST_ATTRIBUTE } from '../selectors';
import cardCss from './card.css?inline';

/**
 * The tokens with `:root` swapped for `:host`, plus the page's own theme class picking the
 * colour scheme, so cards follow chatgpt.com's light/dark setting rather than only the OS.
 * Every colour token is `light-dark()`, so `color-scheme` is all that has to change.
 */
export function hostTokens(css: string): string {
  return [
    css.replaceAll(':root', ':host'),
    ':host-context(html.light) { color-scheme: light !important; }',
    ':host-context(html.dark) { color-scheme: dark !important; }'
  ].join('\n');
}

const STYLES = `${hostTokens(tokens)}\n${cardCss}`;

/** A detached element with a closed shadow root holding the card styles. */
export function createHost(kind: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement('div');
  host.setAttribute(BRIDGE_HOST_ATTRIBUTE, kind);
  // Closed: page scripts can't reach into the card through `host.shadowRoot`.
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  root.append(style);
  return { host, root };
}

let fontsRequested = false;

/**
 * Loads Geist and Geist Mono from the extension (web_accessible_resources, dynamic URL).
 * @font-face doesn't work inside a shadow root, so the faces go on the page's FontFaceSet.
 * If the page's CSP blocks them, the token font stacks fall back to the system font.
 */
export function loadFonts(): void {
  if (fontsRequested || typeof FontFace === 'undefined') return;
  fontsRequested = true;
  for (const [family, { path }] of Object.entries(CARD_FONTS)) {
    const face = new FontFace(family, `url(${chrome.runtime.getURL(path)})`, {
      weight: '100 900'
    });
    document.fonts.add(face);
    face.load().catch(() => {
      document.fonts.delete(face);
      console.info('[Bridge] Font blocked by the page; cards use the system font.');
    });
  }
}
