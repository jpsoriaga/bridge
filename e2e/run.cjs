// Pairing, reconnect and lockout against the built desktop app and the unpacked extension.
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, launchApp, launchChrome, enterCode } = require('./lib.cjs');

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

  /** A fresh code: after New code, waits until the app shows a different one. */
  async function getCode() {
    const shown = win.locator('.pairing-code');
    const before = await win.evaluate(
      () => document.querySelector('.pairing-code')?.textContent ?? null
    );
    await win
      .getByRole('button', { name: /Pair extension|Pair again|New code/ })
      .first()
      .click();
    await win.waitForFunction((old) => {
      const text = document.querySelector('.pairing-code')?.textContent ?? null;
      return text !== null && text !== old && /^\d{3} \d{3}$/.test(text);
    }, before);
    return (await shown.innerText()).replace(/\D/g, '');
  }
  /** A code the app refuses: just typed in. */
  async function enter(code) {
    await panel.fill('#pair-code', code);
    await panel.getByRole('button', { name: 'Pair' }).click();
  }
  /** The right code: typed in, then the fingerprint compared and confirmed on both sides. */
  async function pairWith(code) {
    const fingerprint = await enterCode(win, panel, code);
    step(`fingerprint ${fingerprint} matched in the app and the panel; confirmed in both`);
  }
  const wrongFor = (code) => (code === '000000' ? '111111' : '000000');
  /** Pastes `text` into the code field, as Cmd+V would. */
  async function paste(text) {
    await panel.locator('#pair-code').focus();
    await panel.evaluate((t) => {
      const data = new DataTransfer();
      data.setData('text/plain', t);
      document
        .getElementById('pair-code')
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
        );
    }, text);
  }

  // Wrong code, then the right one.
  let code = await getCode();
  await enter(wrongFor(code));
  await panel.locator('#pair-error').waitFor();
  step('wrong code: ' + (await panel.locator('#pair-error').innerText()));

  // The right code, then Cancel: nothing is kept on either side.
  code = await getCode();
  await enter(code);
  await panel.locator('.pairing-fingerprint').waitFor();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await win.getByRole('button', { name: 'Cancel' }).click();
  await panel.locator('#pair-code').waitFor();
  await desktopStatus(win).filter({ hasText: 'Not paired' }).waitFor();
  step('fingerprint shown, then cancelled on both sides: still not paired');

  // Pasting the code as the app shows it ("160 508"), with a dash or with whitespace: only
  // the digits count, a short one waits for more, and a whole one pairs at once. Copy in
  // the app copies the six digits only.
  code = await getCode();
  await win.getByRole('button', { name: 'Copy the pairing code' }).click();
  await win.getByRole('button', { name: 'Copied' }).waitFor();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  if (copied !== code) throw new Error(`Copy put ${JSON.stringify(copied)} on the clipboard`);
  step(`app Copy: ${JSON.stringify(copied)} on the clipboard, no space`);
  for (const text of [`${code.slice(0, 3)}-${code.slice(3, 5)}`, ` ${code.slice(0, 2)} `]) {
    await paste(text);
    const value = await panel.inputValue('#pair-code');
    if (value !== text.replace(/\D/g, '')) throw new Error(`pasted ${text}: field has ${value}`);
    if (await panel.getByRole('button', { name: 'Pair' }).isEnabled()) {
      throw new Error(`Pair enabled at ${value}`);
    }
    await panel.locator('#pair-code').press('Enter');
  }
  await panel.waitForTimeout(300);
  if ((await panel.locator('#pair-error').count()) > 0) throw new Error('a short code was sent');
  step('pasted "123-45" and " 12 ": digits only, Pair off, Enter sends nothing');
  const forms = [
    (c) => `${c.slice(0, 3)} ${c.slice(3)}`,
    (c) => `${c.slice(0, 3)}-${c.slice(3)}`,
    (c) => `  ${c}\n`
  ];
  for (const [i, form] of forms.entries()) {
    const shown = form(code);
    await paste(shown);
    await panel.locator('.pairing-fingerprint').waitFor();
    step(`pasted ${JSON.stringify(shown)}: sent at once, fingerprint shown`);
    if (i === forms.length - 1) break;
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await win.getByRole('button', { name: 'Cancel' }).click();
    await panel.locator('#pair-code').waitFor();
    code = await getCode();
  }

  // Confirming in the panel before the app is refused until the app confirms.
  await panel.getByRole('button', { name: 'They match' }).click();
  await panel.getByText(/Click “They match” in the Bridge app first/).waitFor();
  step('panel confirmed first: told to confirm in the app');
  await win.getByRole('button', { name: 'They match' }).click();
  await panel.getByRole('button', { name: 'They match' }).click();
  await panelStatus.filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
  await desktopStatus(win).filter({ hasText: 'Connected' }).waitFor();
  step(
    `paired: panel=${await panelStatus.innerText()} desktop=${await desktopStatus(win).innerText()}`
  );

  // The extension keeps only the derived key, in the worker's IndexedDB and not in
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

  // Reporting problems: the panel shows the version; both diagnostics blocks and the log
  // file say what happened and never carry the key.
  const version = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../apps/desktop/package.json'), 'utf8')
  ).version;
  await panel.locator('.panel-meta').getByText(`Bridge ${version}`).waitFor();
  const panelDiag = await panel.evaluate(async () => {
    const { id } = await chrome.windows.getCurrent();
    return chrome.runtime.sendMessage({ type: 'diagnostics', windowId: id });
  });
  await win.evaluate(() => window.bridge.copyDiagnostics());
  const appDiag = await app.evaluate(({ clipboard }) => clipboard.readText());
  await win.getByText('Diagnostics copied').waitFor();
  const logText = fs.readFileSync(path.join(APP_DATA, 'logs', 'bridge.log'), 'utf8');
  for (const [name, text, wants] of [
    ['panel', panelDiag, [`Extension:  ${version}`, `App:        ${version}`, 'connected']],
    ['app', appDiag, [`App:            ${version}`, 'Connection:     connected', 'Browser:']],
    ['log', logText, [`Bridge ${version}`, 'connection: connected', 'pairing: code shown']]
  ]) {
    for (const want of wants) {
      if (!text.includes(want)) throw new Error(`${name} diagnostics lack "${want}":\n${text}`);
    }
    if (text.includes(tokenHash)) throw new Error(`${name} diagnostics carry the key`);
    if (/pairing: .*\b\d{6}\b/.test(text)) throw new Error(`${name} logs a pairing code`);
  }
  step('diagnostics: panel, app and log file, without the key');

  // Unpair from the extension (two-step proof over HTTP).
  await panel.getByRole('button', { name: 'Unpair' }).click();
  await panelStatus.filter({ hasText: 'Not paired' }).waitFor();
  await desktopStatus(win).filter({ hasText: 'Not paired' }).waitFor();
  step(`unpaired from extension: desktop=${await desktopStatus(win).innerText()}`);

  // Pair, then unpair from the desktop.
  await pairWith(await getCode());
  await panelStatus.filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
  await nav(win, 'Settings').click();
  await win.getByRole('button', { name: 'Unpair' }).click();
  await nav(win, 'Session').click();
  await panelStatus.filter({ hasText: 'Not paired' }).waitFor({ timeout: 10000 });
  step('unpaired from desktop: panel=' + (await panelStatus.innerText()));

  // Pair, quit the app, relaunch. The alarm is set while the app is gone.
  await pairWith(await getCode());
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
  // Short codes never reach the app, so they don't count: five of them, then five wrong
  // ones still get all five tries.
  for (let i = 1; i <= 5; i++) {
    await panel.fill('#pair-code', code.slice(0, 5));
    await panel.locator('#pair-code').press('Enter');
  }
  await panel.waitForTimeout(300);
  if ((await panel.locator('#pair-error').count()) > 0) throw new Error('a short code counted');
  step('five 5-digit codes: none sent');
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
