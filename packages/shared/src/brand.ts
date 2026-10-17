/**
 * The Bridge mark: a plus and a minus on a diagonal, the two sides of a diff, on a rounded tile.
 * Drawn on a 32-unit grid. assets/logo.svg and the app icons are generated from these values.
 */
export const LOGO_MARK = {
  size: 32,
  radius: 7.5,
  strokeWidth: 3.5,
  paths: ['M7.5 13h9M12 8.5v9', 'M16 23h8.5']
} as const;
