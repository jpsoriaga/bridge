// Packages the built app (out/) with electron-builder for one platform:
//
//   node scripts/package.mjs mac | win | linux
//
// Signing turns on by itself when its secrets are in the environment, and the build is
// unsigned, with a warning, when they aren't. A partial set is an error: a release that
// was meant to be signed must not quietly ship unsigned.
//
//   macOS:   CSC_LINK, CSC_KEY_PASSWORD (Developer ID Application .p12, base64 or a path)
//            APPLE_API_KEY (the .p8 key's contents or a path), APPLE_API_KEY_ID, APPLE_API_ISSUER
//   Windows: WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD
//
// Nothing is published from here (`--publish never`); the release workflow uploads.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SECRETS = {
  mac: ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
  win: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'],
  linux: []
};

/**
 * Whether to sign, from which of the platform's secrets are set: all (sign), none
 * (unsigned) or some (an error naming the missing ones).
 */
export function signingPlan(platform, env) {
  const names = SECRETS[platform];
  if (!names) throw new Error(`Unknown platform ${platform}. Use mac, win or linux.`);
  const set = names.filter((name) => (env[name] ?? '').trim() !== '');
  if (names.length > 0 && set.length === names.length) return { sign: true };
  if (set.length === 0) return { sign: false };
  const missing = names.filter((name) => !set.includes(name));
  throw new Error(
    `Some ${platform} signing secrets are set but not ${missing.join(', ')}. ` +
      'Set all of them to sign, or none to build unsigned.'
  );
}

/** electron-builder arguments and extra environment for the plan. */
export function builderArgs(platform, plan) {
  const target = { mac: '--mac', win: '--win', linux: '--linux' }[platform];
  const args = [target, '--publish', 'never'];
  const env = {};
  if (platform === 'mac' && !plan.sign) {
    // Ad-hoc signature (arm64 Macs run nothing unsigned), no hardened runtime (ad-hoc
    // frameworks fail its library validation), no notarization, and no update checks:
    // the app reads `bridgeBuild.updates` from its package.json.
    args.push(
      '-c.mac.identity=-',
      '-c.mac.hardenedRuntime=false',
      '-c.mac.notarize=false',
      '-c.extraMetadata.bridgeBuild.updates=false'
    );
  }
  if (platform === 'mac' && plan.sign) {
    args.push('-c.mac.notarize=true', '-c.extraMetadata.bridgeBuild.updates=true');
  }
  if (!plan.sign) {
    // Don't pick up whatever certificate happens to be in the keychain.
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  }
  return { args, env };
}

/**
 * notarytool wants APPLE_API_KEY as a path to the .p8 file. CI secrets hold its contents,
 * so those go into a private temp file.
 */
function apiKeyPath(value) {
  if (existsSync(value)) return value;
  if (!value.includes('BEGIN PRIVATE KEY')) {
    throw new Error('APPLE_API_KEY must be the path to the .p8 key or its contents.');
  }
  const dir = mkdtempSync(join(tmpdir(), 'bridge-notary-'));
  const file = join(dir, 'AuthKey.p8');
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = process.argv[2];
  let plan;
  try {
    plan = signingPlan(platform, process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { args, env } = builderArgs(platform, plan);
  const childEnv = { ...process.env, ...env };
  if (platform === 'mac' && plan.sign)
    childEnv.APPLE_API_KEY = apiKeyPath(process.env.APPLE_API_KEY);

  if (plan.sign) {
    console.log(`Packaging for ${platform}: signed${platform === 'mac' ? ' and notarized' : ''}.`);
  } else if (platform === 'linux') {
    console.log('Packaging for linux: AppImage (unsigned; Linux has no signing step).');
  } else {
    const how =
      platform === 'mac'
        ? 'macOS will say it can’t check the app for malware; open it with right-click → Open. Update checks are off in this build.'
        : 'Windows SmartScreen will warn before it runs; choose More info → Run anyway.';
    console.warn(
      `\n⚠️  Packaging for ${platform} UNSIGNED: no ${SECRETS[platform].join(', ')} in the environment.\n   ${how}\n   See RELEASE.md, "Signing".\n`
    );
  }

  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('electron-builder/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: DESKTOP,
    env: childEnv,
    stdio: 'inherit'
  });
  process.exit(result.status ?? 1);
}
