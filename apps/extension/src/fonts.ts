/**
 * The two card fonts, emitted into the build at these fixed paths (vite.config.ts) and
 * listed in their own `web_accessible_resources` entry with `use_dynamic_url`, so a page
 * can't probe a stable URL for them.
 */
export const CARD_FONTS = {
  'Geist Variable': {
    path: 'fonts/geist.woff2',
    source: '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'
  },
  'Geist Mono Variable': {
    path: 'fonts/geist-mono.woff2',
    source: '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2'
  }
} as const;
