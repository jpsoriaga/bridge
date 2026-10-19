// Checks which loopback calls the service worker can make with and without
// `host_permissions: ["http://127.0.0.1/*"]`. Background for PLAN.md, "Phase 2 decisions".
const fs = require('node:fs');
const path = require('node:path');
const { EXT, E2E_PORT, tempDir, launchApp, launchChrome } = require('./lib.cjs');

(async () => {
  const { app } = await launchApp(tempDir('app-data'));

  // A copy of the built extension with host_permissions stripped.
  const stripped = tempDir('ext-nohp');
  fs.cpSync(EXT, stripped, { recursive: true });
  const manifestPath = path.join(stripped, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.host_permissions;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  for (const [label, dir] of [
    ['WITHOUT host_permissions', stripped],
    ['WITH host_permissions', EXT]
  ]) {
    const { ctx, sw } = await launchChrome(dir);
    const result = await sw.evaluate(async (port) => {
      const out = {};
      const base = `http://127.0.0.1:${port}`;
      try {
        const res = await fetch(`${base}/health`);
        out.health = `${res.status} ${await res.text()}`;
      } catch (e) {
        out.health = 'ERR ' + e.message;
      }
      try {
        const res = await fetch(`${base}/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"code":"000000"}'
        });
        out.pair = `${res.status} ${await res.text()}`;
      } catch (e) {
        out.pair = 'ERR ' + e.message;
      }
      out.ws = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.onopen = () => {
          resolve('open');
          ws.close();
        };
        ws.onerror = () => resolve('error');
      });
      return out;
    }, E2E_PORT);
    console.log(label, JSON.stringify(result));
    await ctx.close();
  }
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
