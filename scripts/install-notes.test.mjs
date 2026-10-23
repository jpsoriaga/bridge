import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  builderNames,
  fill,
  installFileName,
  installNotes,
  missingFiles,
  releaseFiles
} from './install-notes.mjs';
import { ROOT } from './version.mjs';

const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');

/** Nothing of the template's machinery is left: no placeholder, no block marker. */
function expectFilled(text) {
  expect(text).not.toMatch(/[{}]/);
  expect(text).not.toContain('<!--');
  expect(text).not.toMatch(/\n{3,}/);
}

describe('releaseFiles', () => {
  it('names each file the way electron-builder.yml and releaseBuilds() do', () => {
    expect(releaseFiles('1.2.0')).toEqual({
      macArm64: 'Bridge-1.2.0-mac-arm64.dmg',
      macX64: 'Bridge-1.2.0-mac-x64.dmg',
      macZipArm64: 'Bridge-1.2.0-mac-arm64.zip',
      macZipX64: 'Bridge-1.2.0-mac-x64.zip',
      win: 'Bridge-1.2.0-win-x64-setup.exe',
      linux: 'Bridge-1.2.0-linux-x86_64.AppImage',
      extension: 'bridge-extension-1.2.0-unpacked.zip',
      storeExtension: 'bridge-extension-1.2.0.zip'
    });
    expect(releaseFiles('1.2.0-beta.3').storeExtension).toBeNull();
  });

  it('reads the templates from electron-builder.yml, so a rename there changes the notes', () => {
    const names = builderNames();
    expect(names.productName).toBe('Bridge');
    for (const section of ['mac', 'dmg', 'win', 'linux']) {
      expect(names[section], section).toContain('${version}');
    }
    const renamed = { ...names, win: '${productName}-${version}-windows.${ext}' };
    expect(releaseFiles('1.2.0', renamed).win).toBe('Bridge-1.2.0-windows.exe');
    expect(() => releaseFiles('1.2.0', { ...names, linux: '${nope}.${ext}' })).toThrow(
      /\$\{nope\}/
    );
  });

  it('matches what the release workflow uploads and smoke-tests', () => {
    const files = releaseFiles('1.2.0');
    const upload = /name: installers-[\s\S]*?path: \|\n([\s\S]*?)\n\n/.exec(WORKFLOW)[1];
    const globs = upload
      .split('\n')
      .map((line) => line.trim().replace('apps/desktop/dist/', ''))
      .filter((glob) => glob && !glob.startsWith('latest'));
    const matches = (name, glob) =>
      new RegExp(`^${glob.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`).test(name);
    for (const name of [files.macArm64, files.macX64, files.macZipArm64, files.win, files.linux]) {
      expect(
        globs.some((glob) => matches(name, glob)),
        name
      ).toBe(true);
    }
    expect(WORKFLOW).toContain('dist/Bridge-*-linux-x86_64.AppImage');
    expect(files.linux).toMatch(/^Bridge-.*-linux-x86_64\.AppImage$/);
  });

  it('agrees with the file names BETA.md shows testers', () => {
    const beta = readFileSync(join(ROOT, 'BETA.md'), 'utf8');
    const version = /`Bridge-(\d+\.\d+\.\d+-beta\.\d+)-mac-arm64\.dmg`/.exec(beta)[1];
    const files = releaseFiles(version);
    for (const name of [files.macArm64, files.macX64, files.win, files.linux, files.extension]) {
      expect(beta).toContain(`\`${name}\``);
    }
  });
});

describe('installNotes', () => {
  for (const tag of ['v1.2.0', 'v1.2.0-beta.3']) {
    it(`fills every placeholder for ${tag}, notes and INSTALL.md`, () => {
      const version = tag.slice(1);
      const files = releaseFiles(version);
      for (const full of [false, true]) {
        const text = installNotes(tag, { full });
        expectFilled(text);
        expect(text.startsWith('## How to install\n')).toBe(true);
        // The table: one row per download, with this version's exact file name.
        for (const name of [
          files.macArm64,
          files.macX64,
          files.win,
          files.linux,
          files.extension
        ]) {
          expect(text, name).toMatch(
            new RegExp(`^\\|.*\\| \`${name.replace(/\./g, '\\.')}\` +\\|$`, 'm')
          );
        }
        expect(text).toContain(`\`${files.macZipArm64}\``);
        expect(text).toContain('About This Mac');
        expect(text).toContain('Run anyway');
        expect(text).toContain('chmod +x');
        expect(text).toContain('Load unpacked');
        expect(text).toContain('Pair extension');
        expect(text).toContain('### You can ignore these files');
        expect(text).toContain('template=beta-bug-report.yml');
      }
    });
  }

  it('gives a beta its "this is a beta" line and BETA.md, and a release the README', () => {
    const beta = installNotes('v1.2.0-beta.3');
    expect(beta).toContain('**This is a beta**');
    expect(beta).toContain('https://github.com/jpsoriaga/bridge/blob/v1.2.0-beta.3/BETA.md');
    expect(beta).not.toContain('README.md');
    expect(beta).not.toContain('Chrome Web Store build');

    const stable = installNotes('v1.2.0');
    expect(stable).not.toContain('This is a beta');
    expect(stable).not.toContain('BETA.md');
    expect(stable).toContain('https://github.com/jpsoriaga/bridge/blob/v1.2.0/README.md');
    expect(stable).toContain('`bridge-extension-1.2.0.zip`: the Chrome Web Store build');
  });

  it('keeps troubleshooting and uninstalling for INSTALL.md, out of the notes', () => {
    const notes = installNotes('v1.2.0-beta.3');
    const full = installNotes('v1.2.0-beta.3', { full: true });
    expect(notes).not.toContain('## Troubleshooting');
    expect(full).toContain('## Troubleshooting');
    expect(full).toContain('is damaged');
    expect(full).toContain('## Uninstall');
    expect(full).toContain('https://github.com/jpsoriaga/bridge/releases/tag/v1.2.0-beta.3');
    expect(installFileName('1.2.0-beta.3')).toBe('Bridge-1.2.0-beta.3-INSTALL.md');
  });

  it('keeps lists tight where a block was dropped, and tables aligned', () => {
    const notes = installNotes('v1.2.0');
    const ignore = notes.split('### You can ignore these files\n\n')[1].split('\n\n')[0];
    expect(ignore.split('\n').every((line) => line.startsWith('- '))).toBe(true);
    const table = notes.split('\n').filter((line) => line.startsWith('|'));
    expect(new Set(table.map((line) => line.length)).size).toBe(1);
  });

  it('refuses a tag that isn’t a version, and a placeholder it can’t fill', () => {
    expect(() => installNotes('vnext')).toThrow(/Not a release tag/);
    expect(() => installNotes('v1.2.0', { template: '## How to install {nope}\n' })).toThrow(
      /No value for \{nope\}/
    );
    expect(fill('{a} and {b}', { a: '1', b: '2' })).toBe('1 and 2');
  });
});

describe('missingFiles', () => {
  it('lists the named files a release folder lacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-assets-'));
    mkdirSync(dir, { recursive: true });
    const files = Object.values(releaseFiles('1.2.0-beta.3')).filter(Boolean);
    for (const name of files.slice(1)) writeFileSync(join(dir, name), 'x');
    expect(missingFiles('v1.2.0-beta.3', dir)).toEqual([files[0]]);
    writeFileSync(join(dir, files[0]), 'x');
    expect(missingFiles('v1.2.0-beta.3', dir)).toEqual([]);
    // A release also needs the store zip.
    expect(missingFiles('v1.2.0-beta.3'.replace('-beta.3', ''), dir).length).toBeGreaterThan(0);
  });
});
