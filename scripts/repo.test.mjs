// Checks that keep copies of a constant in step where a script can't import the TS source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVersion } from '../packages/shared/src/version';
import { isReleaseVersion, ROOT } from './version.mjs';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');

describe('constants copied into scripts', () => {
  it('e2e/lib.cjs uses the shared E2E_PORT', () => {
    const shared = /export const E2E_PORT = (\d+);/.exec(read('packages/shared/src/ports.ts'));
    const e2e = /const E2E_PORT = (\d+);/.exec(read('e2e/lib.cjs'));
    expect(e2e?.[1]).toBe(shared?.[1]);
  });
});

describe('the version rule', () => {
  it('is the same in scripts/version.mjs and @bridge/shared', () => {
    const samples = ['0.0.1', '1.2.0', '1.2.0-beta.1', '1.2.0-beta.0', '1.2.0-rc.1', '01.2.0'];
    for (const version of [...samples, '65535.0.0', '65536.0.0', '1.0', '1.0.0.0', '']) {
      expect(isReleaseVersion(version), version).toBe(parseVersion(version) !== null);
    }
  });
});

describe('workflows', () => {
  it('give every job a timeout (a job that calls a workflow gets it from that workflow)', () => {
    for (const file of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const jobs = read(file)
        .split(/^jobs:\n/m)[1]
        .split(/^ {2}(?=[\w-]+:\n)/m)
        .filter(Boolean);
      expect(jobs.length, file).toBeGreaterThan(2);
      for (const job of jobs) {
        const name = job.split(':')[0];
        if (/^ {4}uses: /m.test(job)) continue;
        expect(job, `${file} ${name}`).toMatch(/^ {4}timeout-minutes: \d+$/m);
      }
    }
  });
});
