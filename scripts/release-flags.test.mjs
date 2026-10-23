// The release workflow's beta handling, checked on the workflow file itself: its release
// steps are cut out of .github/workflows/release.yml and run under bash with a stand-in `gh`
// that records its arguments.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseFlags, releaseIntro } from './release-flags.mjs';
import { ROOT } from './version.mjs';

const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');

/** The `run:` script of the step called `name`, dedented. */
function stepScript(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`No step "${name}"`);
  const stepIndent = lines[start].indexOf('-');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= stepIndent) break;
    body.push(line);
  }
  const runAt = body.findIndex((line) => /^\s*run:/.test(line));
  if (runAt === -1) throw new Error(`Step "${name}" has no run`);
  const inline = body[runAt].replace(/^\s*run:\s*/, '');
  if (inline !== '|') return inline;
  const runIndent = body[runAt].search(/\S/);
  const script = [];
  for (const line of body.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
    script.push(line);
  }
  const indent = Math.min(...script.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return script.map((line) => line.slice(indent)).join('\n');
}

/** Runs the notes and create steps for `tag` with a fake `gh`: its argv and the notes. */
function runRelease(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-release-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'Bridge.dmg'), 'x');
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$GH_ARGS"\n');
  chmodSync(gh, 0o755);
  const script = [
    stepScript(WORKFLOW, 'Release notes from CHANGELOG.md'),
    stepScript(WORKFLOW, 'Create the draft release')
  ]
    .join('\n')
    .replaceAll('scripts/', `${join(ROOT, 'scripts')}/`)
    .replaceAll('assets/*', `${join(dir, 'assets')}/*`)
    .replaceAll('> notes.md', `> ${join(dir, 'notes.md')}`)
    .replaceAll('>> notes.md', `>> ${join(dir, 'notes.md')}`)
    .replaceAll('--notes-file notes.md', `--notes-file ${join(dir, 'notes.md')}`);
  const result = spawnSync('bash', ['-e', '-c', script], {
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GITHUB_REF_NAME: tag,
      GITHUB_REPOSITORY: 'jpsoriaga/bridge',
      GH_ARGS: join(dir, 'gh-args.txt'),
      GH_TOKEN: 'unused'
    },
    encoding: 'utf8'
  });
  return {
    status: result.status,
    stderr: result.stderr,
    args: result.status === 0 ? readFileSync(join(dir, 'gh-args.txt'), 'utf8').split('\n') : [],
    notes: result.status === 0 ? readFileSync(join(dir, 'notes.md'), 'utf8') : ''
  };
}

describe('releaseFlags', () => {
  it('marks betas as pre-releases that are never Latest, and leaves releases alone', () => {
    expect(releaseFlags('v1.2.0')).toEqual([]);
    expect(releaseFlags('v1.2.0-beta.1')).toEqual(['--prerelease', '--latest=false']);
    expect(releaseIntro('v1.2.0')).toBe('');
    expect(releaseIntro('v1.2.0-beta.1')).toContain('/blob/v1.2.0-beta.1/BETA.md');
  });

  it('refuses tags that aren’t versions', () => {
    for (const bad of ['1.2.0', 'v1.2', 'v1.2.0-rc.1', 'vnext', '']) {
      expect(() => releaseFlags(bad), bad).toThrow(/Not a release tag/);
    }
  });
});

describe('release.yml', () => {
  it('runs on v* tags, checks the tag early, and makes only drafts', () => {
    expect(WORKFLOW).toMatch(/on:\n\s+push:\n\s+tags: \['v\*'\]/);
    expect(stepScriptsOf('version')).toContain('node scripts/release-flags.mjs "$TAG"');
    expect(stepScript(WORKFLOW, 'Create the draft release')).toContain('--draft');
  });

  it('runs by hand only as a dry run: the release job is for tag pushes, dry-run never writes', () => {
    expect(WORKFLOW).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(stepScriptsOf('release')).toMatch(/^ {4}if: github\.event_name == 'push'$/m);
    const dryRun = stepScriptsOf('dry-run');
    expect(dryRun).toMatch(/^ {4}if: github\.event_name == 'workflow_dispatch'$/m);
    expect(dryRun).not.toContain('permissions');
    expect(dryRun).not.toContain('gh ');
    expect(dryRun).not.toContain('secrets.');
  });

  it.skipIf(process.platform === 'win32')(
    'takes the pushed tag, or for a dry run the packages’ version',
    () => {
      const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
      expect(runTagStep('workflow_dispatch', 'main')).toEqual({
        output: `tag=v${version}`,
        env: `TAG=v${version}`
      });
      expect(runTagStep('push', 'v1.1.0')).toEqual({ output: 'tag=v1.1.0', env: 'TAG=v1.1.0' });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'dry run: writes the files, flags and notes to the summary',
    () => {
      const tag = changelogBeta();
      const dir = mkdtempSync(join(tmpdir(), 'bridge-dry-run-'));
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'assets', 'Bridge.dmg'), 'x');
      const summary = join(dir, 'summary.md');
      const script = stepScript(WORKFLOW, 'What the release would hold').replaceAll(
        'scripts/',
        `${join(ROOT, 'scripts')}/`
      );
      const result = spawnSync('bash', ['-e', '-c', script], {
        cwd: dir,
        env: { ...process.env, TAG: tag, GITHUB_STEP_SUMMARY: summary },
        encoding: 'utf8'
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const text = readFileSync(summary, 'utf8');
      expect(text).toContain(`## Dry run: Bridge ${tag.slice(1)}`);
      expect(text).toContain('No release was created.');
      expect(text).toContain('(`--draft --prerelease --latest=false`)');
      expect(text).toMatch(/[0-9a-f]{64} {2}Bridge\.dmg/);
      expect(text).toContain('**Beta for testers.**');
      expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain('**Beta for testers.**');
    }
  );

  // The steps are bash; Windows runners aren't where the release job runs.
  it.skipIf(process.platform === 'win32')('creates a normal draft for vX.Y.Z, as before', () => {
    const run = runRelease('v1.1.0');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.args).toContain('--draft');
    expect(run.args).toContain('--verify-tag');
    expect(run.args).not.toContain('--prerelease');
    expect(run.args).not.toContain('--latest=false');
    expect(run.args[run.args.indexOf('--title') + 1]).toBe('Bridge 1.1.0');
    expect(run.notes).not.toContain('Beta for testers');
  });

  it.skipIf(process.platform === 'win32')(
    'creates a pre-release draft, not Latest, for vX.Y.Z-beta.N',
    () => {
      const tag = changelogBeta();
      const run = runRelease(tag);
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(run.args).toContain('--draft');
      expect(run.args).toContain('--prerelease');
      expect(run.args).toContain('--latest=false');
      expect(run.args[run.args.indexOf('--title') + 1]).toBe(`Bridge ${tag.slice(1)}`);
      expect(run.notes.startsWith('**Beta for testers.**')).toBe(true);
    }
  );

  it.skipIf(process.platform === 'win32')('fails on a tag that isn’t a version', () => {
    expect(runRelease('vnext').status).not.toBe(0);
  });
});

/** Runs the version job's Tag step for an event; its GITHUB_OUTPUT and GITHUB_ENV lines. */
function runTagStep(event, refName) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tag-'));
  const output = join(dir, 'output');
  const env = join(dir, 'env');
  const result = spawnSync('bash', ['-e', '-c', stepScript(WORKFLOW, 'Tag')], {
    cwd: ROOT,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_REF_NAME: refName,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: env
    },
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return {
    output: readFileSync(output, 'utf8').trim(),
    env: readFileSync(env, 'utf8').trim()
  };
}

/** Every `run:` line of the job called `job`. */
function stepScriptsOf(job) {
  const start = WORKFLOW.indexOf(`\n  ${job}:\n`);
  const end = WORKFLOW.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return WORKFLOW.slice(start, end === -1 ? undefined : start + 1 + end);
}

/** A beta tag with a CHANGELOG section (the release step needs one): the newest, or a fake. */
function changelogBeta() {
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const beta = /^## \[(\d+\.\d+\.\d+-beta\.\d+)\]/m.exec(text)?.[1];
  if (!beta) throw new Error('CHANGELOG.md has no beta section to test the release steps with');
  return `v${beta}`;
}
