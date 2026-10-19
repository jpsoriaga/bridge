// No imports: apps/extension/vite.config.ts loads this file directly under Node.

/** The desktop listens on the first free port in `DEFAULT_PORT .. DEFAULT_PORT + PORT_RANGE - 1`. */
export const DEFAULT_PORT = 47821;
export const PORT_RANGE = 10;
/**
 * First port of the range the e2e scripts use (a dev app launched with `BRIDGE_E2E=1` and an
 * extension built with it), so they never meet a `pnpm dev` app on the real range.
 */
export const E2E_PORT = 47921;

export function candidatePorts(base: number = DEFAULT_PORT): number[] {
  return Array.from({ length: PORT_RANGE }, (_, i) => base + i);
}
