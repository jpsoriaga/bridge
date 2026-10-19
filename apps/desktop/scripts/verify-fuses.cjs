// Checks a built app's Electron fuses against scripts/fuses.cjs.
//   node scripts/verify-fuses.cjs dist/mac-arm64/Bridge.app
//   node scripts/verify-fuses.cjs dist/win-unpacked/Bridge.exe
// Prints each fuse and exits 1 if any differs.
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');
const { FUSES, mismatches } = require('./fuses.cjs');

(async () => {
  const target = process.argv[2];
  if (!target) {
    console.error(
      'Usage: node scripts/verify-fuses.cjs <path to Bridge.app, Bridge.exe or bridge>'
    );
    process.exit(2);
  }
  const wire = await getCurrentFuseWire(target);
  const wrong = mismatches(wire);
  for (const index of Object.keys(FUSES)) {
    const bad = wrong.find((w) => w.fuse === FuseV1Options[index]);
    console.log(
      `${bad ? '✗' : '✓'} ${FuseV1Options[index]}: ${bad ? `${bad.found}, wanted ${bad.wanted}` : FUSES[index] ? 'on' : 'off'}`
    );
  }
  if (wrong.length > 0) {
    console.error(`${wrong.length} fuse(s) not as configured.`);
    process.exit(1);
  }
  console.log('Fuses OK');
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
