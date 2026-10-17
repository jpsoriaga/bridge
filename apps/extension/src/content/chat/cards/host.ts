import tokens from '@bridge/shared/tokens.css?inline';
import geistUrl from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import geistMonoUrl from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';
import { BRIDGE_HOST_ATTRIBUTE } from '../selectors';
import cardCss from './card.css?inline';

/**
 * The tokens with `:root` swapped for `:host`, plus copies keyed to the page's own theme
 * class, so cards follow chatgpt.com's light/dark setting rather than only the OS.
 */
export function hostTokens(css: string): string {
  const light = /:root\s*\{[^}]*\}/.exec(css)?.[0];
  const dark = /@media \(prefers-color-scheme: dark\)\s*\{\s*(:root\s*\{[^}]*\})/.exec(css)?.[1];
  return [
    css.replaceAll(':root', ':host'),
    light?.replace(':root', ':host-context(html.light)'),
    dark?.replace(':root', ':host-context(html.dark)')
  ]
    .filter(Boolean)
    .join('\n');
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
 * Loads Geist and Geist Mono from the extension (web_accessible_resources). @font-face
 * doesn't work inside a shadow root, so the faces go on the page's FontFaceSet. If the
 * page's CSP blocks them, the token font stacks fall back to the system font.
 */
export function loadFonts(): void {
  if (fontsRequested || typeof FontFace === 'undefined') return;
  fontsRequested = true;
  const faces = [
    new FontFace('Geist Variable', `url(${chrome.runtime.getURL(geistUrl)})`, {
      weight: '100 900'
    }),
    new FontFace('Geist Mono Variable', `url(${chrome.runtime.getURL(geistMonoUrl)})`, {
      weight: '100 900'
    })
  ];
  for (const face of faces) {
    document.fonts.add(face);
    face.load().catch(() => {
      document.fonts.delete(face);
      console.info('[Bridge] Font blocked by the page; cards use the system font.');
    });
  }
}
