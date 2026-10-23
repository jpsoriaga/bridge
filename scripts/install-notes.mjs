// The install instructions every release carries, filled in from scripts/release/install-notes.md
// for one version (RELEASE.md, "Release notes"):
//
//   node scripts/install-notes.mjs notes <tag>         the "How to install" section for the notes
//   node scripts/install-notes.mjs write <tag> <dir>   <dir>/Bridge-<version>-INSTALL.md
//   node scripts/install-notes.mjs check <tag> <dir>   fail unless <dir> holds every file it names
//
// File names come from where the builds get them: the installers from electron-builder.yml's
// artifactName templates, the extension zips from releaseBuilds(). Fails on a tag that isn't
// a version.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseBuilds } from './release-extension.mjs';
import { releaseFlags } from './release-flags.mjs';
import { isBeta, ROOT } from './version.mjs';

export const TEMPLATE = join(ROOT, 'scripts', 'release', 'install-notes.md');
const BUILDER_CONFIG = join(ROOT, 'apps', 'desktop', 'electron-builder.yml');

/**
 * `artifactName` of each top-level section of electron-builder.yml, and its `productName`.
 * The file is flat enough that a full YAML parser isn't needed.
 */
export function builderNames(text = readFileSync(BUILDER_CONFIG, 'utf8')) {
  const names = {};
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const top = /^([A-Za-z]\w*):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      if (section === 'productName') names.productName = top[2].trim();
      continue;
    }
    const artifact = /^ {2}artifactName:\s*(\S+)\s*$/.exec(line);
    if (artifact && section) names[section] = artifact[1];
  }
  return names;
}

/** An electron-builder artifactName template with its macros filled in. */
function expand(template, macros) {
  return template.replace(/\$\{(\w+)\}/g, (_, name) => {
    if (!(name in macros)) throw new Error(`Unknown macro \${${name}} in ${template}`);
    return macros[name];
  });
}

/**
 * Every file name the install instructions mention for `version`. electron-builder names an
 * AppImage's x64 arch `x86_64`; everything else keeps the arch as given.
 */
export function releaseFiles(version, names = builderNames()) {
  const base = { productName: names.productName, version };
  const extension = releaseBuilds(version);
  return {
    macArm64: expand(names.dmg, { ...base, arch: 'arm64', ext: 'dmg' }),
    macX64: expand(names.dmg, { ...base, arch: 'x64', ext: 'dmg' }),
    macZipArm64: expand(names.mac, { ...base, arch: 'arm64', ext: 'zip' }),
    macZipX64: expand(names.mac, { ...base, arch: 'x64', ext: 'zip' }),
    win: expand(names.win, { ...base, arch: 'x64', ext: 'exe' }),
    linux: expand(names.linux, { ...base, arch: 'x86_64', ext: 'AppImage' }),
    extension: extension.find((build) => build.key).zip,
    storeExtension: extension.find((build) => !build.key)?.zip ?? null
  };
}

/** The INSTALL.md the release attaches. */
export const installFileName = (version) => `Bridge-${version}-INSTALL.md`;

/** Keeps or drops each `<!-- name -->…<!-- /name -->` block of `text`. */
function blocks(text, keep) {
  return text.replace(/^<!-- (\w+) -->\n([\s\S]*?)^<!-- \/\1 -->\n/gm, (_, name, body) =>
    keep[name] ? body : ''
  );
}

/** Replaces each `{name}` in `text`; fails on one it doesn't know. */
export function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    if (values[name] == null) throw new Error(`No value for {${name}}`);
    return values[name];
  });
}

/**
 * The install instructions for `tag`: the release notes' section, or (`full`) the INSTALL.md
 * with troubleshooting and uninstall steps too.
 */
export function installNotes(
  tag,
  { full = false, template = readFileSync(TEMPLATE, 'utf8') } = {}
) {
  releaseFlags(tag); // throws unless it's a version tag
  const version = tag.replace(/^v/, '');
  const beta = isBeta(version);
  const body = blocks(template.replace(/^<!--[\s\S]*?-->\n+/, ''), {
    beta,
    stable: !beta,
    full
  });
  const text = fill(body, { version, tag, ...releaseFiles(version) })
    // A dropped block leaves its blank lines behind, and a kept one inside a list its own.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(- .*)\n\n(?=- )/gm, '$1\n');
  return `${alignTables(text).trim()}\n`;
}

/** Pads each Markdown table's columns to their widest cell again, as Prettier does. */
function alignTables(text) {
  return text.replace(/(?:^\|.*\|\n)+/gm, (table) => {
    const rows = table
      .trimEnd()
      .split('\n')
      .map((row) =>
        row
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim())
      );
    const widths = rows[0].map((_, i) =>
      Math.max(...rows.map((row) => (/^-+$/.test(row[i]) ? 3 : row[i].length)))
    );
    const line = (row) =>
      `| ${row.map((cell, i) => (/^-+$/.test(cell) ? '-'.repeat(widths[i]) : cell.padEnd(widths[i]))).join(' | ')} |\n`;
    return rows.map(line).join('');
  });
}

/** The files the instructions for `tag` name that aren't in `dir`. */
export function missingFiles(tag, dir) {
  const version = tag.replace(/^v/, '');
  const named = Object.values(releaseFiles(version)).filter(Boolean);
  return named.filter((name) => !existsSync(join(dir, name)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [command, tag = '', dir] = process.argv.slice(2);
    if (command === 'notes') {
      process.stdout.write(installNotes(tag));
    } else if (command === 'write' && dir) {
      const path = join(dir, installFileName(tag.replace(/^v/, '')));
      writeFileSync(path, installNotes(tag, { full: true }));
      console.log(path);
    } else if (command === 'check' && dir) {
      const missing = missingFiles(tag, dir);
      if (missing.length > 0) {
        throw new Error(
          `The install notes name files the release doesn't have: ${missing.join(', ')}`
        );
      }
    } else {
      console.error('Usage: node scripts/install-notes.mjs notes <tag> | write|check <tag> <dir>');
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
