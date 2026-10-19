// Electron fuses for the packaged app: flipped in the binary by electron-builder's
// `afterPack` hook (electron-builder.yml), so they can't be turned back on at runtime.
// `node scripts/verify-fuses.cjs <app>` checks a built app against the same table.
const path = require('node:path');
const { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } = require('@electron/fuses');

/** How a fuse reads in the binary: the bytes '1' and '0' (`FuseState` isn't exported). */
const FuseState = { ENABLE: 0x31, DISABLE: 0x30 };

/** The one table. true: on, false: off. Fuses not listed keep Electron's default. */
const FUSES = {
  // ELECTRON_RUN_AS_NODE would turn the app into a plain Node with its entitlements.
  [FuseV1Options.RunAsNode]: false,
  // NODE_OPTIONS and --inspect would let anything that can launch the app inject code.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Only the signed app.asar, checked against its hash, is ever loaded.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Cookies on disk are encrypted with the OS keychain.
  [FuseV1Options.EnableCookieEncryption]: true
};

/** Where the Electron binary is inside a packaged app, per platform. */
function electronBinary(appOutDir, platform, productFilename) {
  if (platform === 'darwin' || platform === 'mas') {
    return path.join(appOutDir, `${productFilename}.app`);
  }
  if (platform === 'win32') return path.join(appOutDir, `${productFilename}.exe`);
  return path.join(appOutDir, productFilename.toLowerCase());
}

/** Fuses whose state in `wire` (from getCurrentFuseWire) differs from FUSES. */
function mismatches(wire) {
  const out = [];
  for (const [index, wanted] of Object.entries(FUSES)) {
    const state = wire[index];
    const want = wanted ? FuseState.ENABLE : FuseState.DISABLE;
    if (state !== want) {
      out.push({
        fuse: FuseV1Options[index],
        wanted: wanted ? 'on' : 'off',
        found: state === FuseState.ENABLE ? 'on' : state === FuseState.DISABLE ? 'off' : 'missing'
      });
    }
  }
  return out;
}

/** electron-builder `afterPack`: flips the fuses, then checks they took. */
async function afterPack(context) {
  const binary = electronBinary(
    context.appOutDir,
    context.electronPlatformName,
    context.packager.appInfo.productFilename
  );
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // Flipping invalidates the ad-hoc signature arm64 macOS needs to launch at all.
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' && context.arch === 3,
    ...FUSES
  });
  const wrong = mismatches(await getCurrentFuseWire(binary));
  if (wrong.length > 0) throw new Error(`Fuses not applied: ${JSON.stringify(wrong)}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.FUSES = FUSES;
module.exports.electronBinary = electronBinary;
module.exports.mismatches = mismatches;
