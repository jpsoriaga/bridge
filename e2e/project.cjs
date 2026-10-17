// Phase 3: project folder, sandboxed tree/read/write, backups and undo, over the real socket.
// Uses a dev build of the extension, since the side panel's file test path exists only there.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, tempDir, launchApp, launchChrome } = require('./lib.cjs');

const step = (m) => console.log('•', m);
const SHOTS = process.env.E2E_SCREENSHOTS;

(async () => {
  // A small project, reopened on launch through settings.json.
  const project = path.join(fs.realpathSync(tempDir('project')), 'demo-app');
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  };
  write('src/index.ts', 'export const a = 1;\n');
  write('win.txt', 'one\r\ntwo\r\n');
  write('.env', 'SECRET=1\n');
  write('.git/config', '[core]\n');
  write('.gitignore', 'dist/\n*.log\n');
  write('debug.log', 'x');
  const appData = tempDir('app-data');
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({ project, recentProjects: [project], denyPatterns: [] })
  );

  const extDir = tempDir('ext-dev');
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@bridge/extension',
      'exec',
      'vite',
      'build',
      '--mode',
      'development',
      '--outDir',
      extDir,
      '--emptyOutDir'
    ],
    { cwd: ROOT, stdio: 'ignore' }
  );

  const { app, win } = await launchApp(appData);
  await win.locator('.project-name').filter({ hasText: 'demo-app' }).waitFor();
  step('desktop header: ' + (await win.locator('.project-head').innerText()).replace(/\n/g, ' '));

  const { ctx, extId } = await launchChrome(extDir);
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  await win.getByRole('button', { name: 'Pair extension' }).click();
  const code = (await win.locator('.pairing-code').innerText()).replace(/\D/g, '');
  await panel.fill('#pair-code', code);
  await panel.getByRole('button', { name: 'Pair' }).click();
  await panel
    .locator('header .status')
    .filter({ hasText: 'Connected' })
    .waitFor({ timeout: 10000 });
  await panel.getByText('demo-app', { exact: true }).waitFor();
  step('panel project: ' + (await panel.locator('.path').innerText()));

  const file = (request) =>
    panel.evaluate((r) => chrome.runtime.sendMessage({ type: 'dev-file', request: r }), request);
  const expectCode = async (request, code) => {
    const outcome = await file(request);
    if (outcome.ok || outcome.error.code !== code)
      throw new Error(`expected ${code}: ${JSON.stringify(outcome)}`);
    if (JSON.stringify(outcome).includes(project)) throw new Error('absolute path leaked');
    step(`${request.type} ${request.payload.path ?? ''} → ${code}`);
  };

  const tree = await file({ type: 'tree', payload: {} });
  step(
    'tree: ' +
      tree.result.entries.map((e) => e.path).join(', ') +
      ` (truncated=${tree.result.truncated})`
  );
  if (tree.result.entries.some((e) => /\.env|\.git\/|debug\.log/.test(e.path)))
    throw new Error('tree leaked');

  const read = await file({ type: 'read', payload: { path: 'src/index.ts' } });
  step(`read src/index.ts: ${JSON.stringify(read.result.content)} eol=${read.result.eol}`);

  const modify = await file({
    type: 'write',
    payload: {
      trigger: 'click',
      path: 'src/index.ts',
      content: 'export const a = 2;\n',
      baseHash: read.result.hash
    }
  });
  step(
    `write (modify): ${modify.result.kind} → disk ${JSON.stringify(fs.readFileSync(path.join(project, 'src/index.ts'), 'utf8'))}`
  );
  const create = await file({
    type: 'write',
    payload: { trigger: 'click', path: 'src/new/util.ts', content: 'export {};\n' }
  });
  step(
    `write (create): ${create.result.kind}, exists=${fs.existsSync(path.join(project, 'src/new/util.ts'))}`
  );
  const win1 = await file({ type: 'read', payload: { path: 'win.txt' } });
  await file({
    type: 'write',
    payload: {
      trigger: 'click',
      path: 'win.txt',
      content: 'uno\ndos\n',
      baseHash: win1.result.hash
    }
  });
  step(`CRLF kept: ${JSON.stringify(fs.readFileSync(path.join(project, 'win.txt'), 'utf8'))}`);

  await expectCode(
    {
      type: 'write',
      payload: {
        trigger: 'click',
        path: 'src/index.ts',
        content: 'stale',
        baseHash: read.result.hash
      }
    },
    'conflict'
  );
  await expectCode(
    { type: 'write', payload: { trigger: 'click', path: 'src/new/util.ts', content: 'again' } },
    'exists'
  );
  await expectCode({ type: 'read', payload: { path: '../../etc/passwd' } }, 'traversal');
  await expectCode({ type: 'read', payload: { path: '/etc/passwd' } }, 'absolute-path');
  await expectCode({ type: 'read', payload: { path: '.env' } }, 'denied');
  await expectCode({ type: 'read', payload: { path: '.GIT/config' } }, 'denied');
  await expectCode(
    { type: 'write', payload: { trigger: 'click', path: '.env.local', content: 'x' } },
    'denied'
  );
  if (fs.existsSync(path.join(project, '.env.local'))) throw new Error('.env.local was written');

  // The desktop activity list: writes with Undo, and the blocked requests.
  await win.locator('.activity-row').first().waitFor();
  const rows = await win.locator('.activity-row').allInnerTexts();
  step(
    `activity rows: ${rows.length}, e.g. ${rows
      .slice(0, 3)
      .map((r) => r.replace(/\n/g, ' | '))
      .join(' ;; ')}`
  );
  const backups = fs.readdirSync(path.join(appData, 'backups'));
  step(
    `backups in userData: ${backups.length} project(s), none in project=${!fs.readdirSync(project).some((n) => n.includes('backup'))}`
  );
  if (SHOTS) {
    await win.evaluate(() => window.scrollTo(0, 0));
    await win.screenshot({ path: path.join(SHOTS, 'desktop-top.png') });
    await win.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await win.screenshot({ path: path.join(SHOTS, 'desktop.png') });
  }

  // Undo last (the CRLF modify), then per-entry undo of the create.
  await win.getByRole('button', { name: 'Undo last' }).click();
  await win.waitForFunction(() => document.querySelector('.activity-row[data-undone="true"]'));
  step(
    `undo last: win.txt ${JSON.stringify(fs.readFileSync(path.join(project, 'win.txt'), 'utf8'))}`
  );
  await win
    .locator('.activity-row', { hasText: 'src/new/util.ts' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await win.locator('.activity-row[data-undone="true"]', { hasText: 'src/new/util.ts' }).waitFor();
  step(`undo create: exists=${fs.existsSync(path.join(project, 'src/new/util.ts'))}`);

  // External edit, then undo: the extension's undo refuses; the app asks and then restores.
  fs.writeFileSync(path.join(project, 'src/index.ts'), 'edited in an editor\n');
  await expectCode({ type: 'undo', payload: { opId: modify.result.opId } }, 'conflict');
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await win
    .locator('.activity-row', { hasText: 'src/index.ts' })
    .filter({ hasText: 'Modified' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await win.locator('.activity-row[data-undone="true"]', { hasText: 'src/index.ts' }).waitFor();
  step(
    `undo after external edit (confirmed): ${JSON.stringify(fs.readFileSync(path.join(project, 'src/index.ts'), 'utf8'))}`
  );

  if (SHOTS) {
    await win.screenshot({ path: path.join(SHOTS, 'desktop-after-undo.png') });
    await panel.setViewportSize({ width: 360, height: 760 });
    await panel
      .locator('#root, body')
      .first()
      .screenshot({ path: path.join(SHOTS, 'panel.png') });
  }

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
