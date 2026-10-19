// Checks that keep copies of a constant in step where a script can't import the TS source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './version.mjs';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');

describe('constants copied into scripts', () => {
  it('e2e/lib.cjs uses the shared E2E_PORT', () => {
    const shared = /export const E2E_PORT = (\d+);/.exec(read('packages/shared/src/ports.ts'));
    const e2e = /const E2E_PORT = (\d+);/.exec(read('e2e/lib.cjs'));
    expect(e2e?.[1]).toBe(shared?.[1]);
  });
});
