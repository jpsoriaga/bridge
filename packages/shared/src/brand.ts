/**
 * The Bridge mark: a suspension bridge (two towers, a deck, one cable) on a rounded tile.
 * Drawn on a 32-unit grid. assets/logo.svg and the app icons are generated from these values.
 */
export const LOGO_MARK = {
  size: 32,
  radius: 7.5,
  strokeWidth: 2.25,
  paths: ['M11 8.5v15M21 8.5v15', 'M5 19h22', 'M5 19 11 9.5c2.5 5.5 7.5 5.5 10 0L27 19']
} as const;
