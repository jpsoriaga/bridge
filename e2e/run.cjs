// Pairing, reconnect and lockout against the built desktop app and the unpacked extension.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, launchApp, launchChrome } = require('./lib.cjs');

const APP_DATA = tempDir('app-data');
const step = (m) => console.log('•', m);
const desktopStatus = (win) => win.locator('header .status');
const nav = (win, name) =>
  win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });

/** Runs in the service worker: the pairing key from its IndexedDB, or null. */
function readIdbKey() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('bridge-keys');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('keys')) return resolve(null);
      const get = db.transaction('keys').objectStore('keys').get('tokenHash');
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror = () => reject(get.error);
    };
  });
}

(async () => {
  let { app, win } = await launchApp(APP_DATA);
  await desktopStatus(win).filter({ hasText: 'Not paired' }).waitFor();
  await nav(win, 'Settings').click();
  step(
    `desktop: ${await desktopStatus(win).innerText()} / ${await win.locator('.settings dd').first().innerText()}`
  );
  await nav(win, 'Session').click();

  const { ctx, sw, extId } = await launchChrome();
  step('extension id: ' + extId);

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  const panelStatus = panel.locator('header .status');
  await panelStatus.filter({ hasText: 'Not paired' }).waitFor({ timeout: 10000 });
  step('panel: ' + (await panelStatus.innerText()));

  async function getCode() {
    await win
      .getByRole('button', { name: /Pair extension|Pair again|New code/ })
      .first()
      .click();
    return (await win.locator('.pairing-code').innerText()).replace(/\D/g, '');
  }
  async function enter(code) {
    await panel.fill('#pair-code', code);
    await panel.getByRole('button', { name: 'Pair' }).click();
  }
  const wrongFor = (code) => (code === '000000' ? '111111' : '000000');

  // Wrong code, then the right one.
  let code = await getCode();
  await enter(wrongFor(code));
  await panel.locator('#pair-error').waitFor();
  step('wrong code: ' + (await panel.locator('#pair-error').innerText()));
  await enter(code);
  await panelStatus.filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
  await desktopStatus(win).filter({ hasText: 'Connected' }).waitFor();
  step(
    `paired: panel=${await panelStatus.innerText()} desktop=${await desktopStatus(win).innerText()}`
  );

  // The extension keeps only the token's hash, in the worker's IndexedDB and not in
  // chrome.storage.local (which content scripts can read); the desktop file is encrypted.
  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  step(`extension storage keys: ${Object.keys(stored).sort().join(',')}`);
  if ('token' in stored || 'tokenHash' in stored) throw new Error('key in chrome.storage');
  const tokenHash = await sw.evaluate(readIdbKey);
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('no key in IndexedDB');
  step('key is in the worker IndexedDB only');
  const pairingFile = fs.readFileSync(path.join(APP_DATA, 'pairing.json'), 'utf8');
  step(
    `pairing.json: encrypted=${JSON.parse(pairingFile).encrypted} plainKey=${pairingFile.includes(tokenHash)}`
  );
  const alarms = await sw.evaluate(() => chrome.alarms.getAll());
  step(`alarms while connected: ${alarms.length}`);

  // Unpair from the extension (two-step proof over HTTP).
  await panel.getByRole('button', { name: 'Unpair' }).click();
  await panelStatus.filter({ hasText: 'Not paired' }).waitFor();
  await desktopStatus(win).filter({ hasText: 'Not paired' }).waitFor();
  step(`unpaired from extension: desktop=${await desktopStatus(win).innerText()}`);

  // Pair, then unpair from the desktop.
  await enter(await getCode());
  await panelStatus.filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
  await nav(win, 'Settings').click();
  await win.getByRole('button', { name: 'Unpair' }).click();
  await nav(win, 'Session').click();
  await panelStatus.filter({ hasText: 'Not paired' }).waitFor({ timeout: 10000 });
  step('unpaired from desktop: panel=' + (await panelStatus.innerText()));

  // Pair, quit the app, relaunch. The alarm is set while the app is gone.
  await enter(await getCode());
  await panelStatus.filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
  await app.close();
  const t0 = Date.now();
  await panelStatus.filter({ hasText: 'App not running' }).waitFor({ timeout: 15000 });
  step(`app quit: panel=${await panelStatus.innerText()} after ${Date.now() - t0}ms`);
  step(
    'alarms while disconnected: ' +
      JSON.stringify((await sw.evaluate(() => chrome.alarms.getAll())).map((a) => a.name))
  );
  ({ app, win } = await launchApp(APP_DATA));
  const t1 = Date.now();
  await panelStatus.filter({ hasText: 'Connected' }).waitFor({ timeout: 40000 });
  await desktopStatus(win).filter({ hasText: 'Connected' }).waitFor();
  step(
    `relaunched: reconnected after ${Date.now() - t1}ms, desktop=${await desktopStatus(win).innerText()}`
  );
  step(`alarms after reconnect: ${(await sw.evaluate(() => chrome.alarms.getAll())).length}`);

  // Five wrong codes lock pairing.
  await panel.getByRole('button', { name: 'Unpair' }).click();
  await panelStatus.filter({ hasText: 'Not paired' }).waitFor();
  code = await getCode();
  for (let i = 1; i <= 5; i++) {
    await enter(wrongFor(code));
    await panel.locator('#pair-error').waitFor();
    await panel.waitForFunction(() => document.querySelector('#pair-code')?.value === '');
    await panel.waitForTimeout(150);
    step(`wrong #${i}: ${await panel.locator('#pair-error').innerText()}`);
  }
  await enter(code);
  await panel.waitForTimeout(300);
  step('right code while locked: ' + (await panel.locator('#pair-error').innerText()));
  await win.locator('.error-text').waitFor();
  step(
    `desktop lock notice: ${await win.locator('.error-text').innerText()} | code still shown=${await win.locator('.pairing-code').count()}`
  );

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
