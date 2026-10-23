import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  candidatePorts,
  DEFAULT_PORT,
  E2E_PORT,
  formatArgv,
  MAX_RUN_TIMEOUT_MS,
  MAX_STEP_LIMIT,
  MIN_RUN_TIMEOUT_MS,
  MODES,
  OpId,
  RunId,
  serverMessage,
  type BridgeConfig,
  type LoopReport,
  type Mode,
  type RunResult
} from '@bridge/shared';
import {
  IPC,
  type CommandPath,
  type DesktopState,
  type MenuAction,
  type OpenFolderResult,
  type RunDetail,
  type RunningCommand,
  type RunSettings,
  type SaveListResult,
  type UndoOutcome
} from '../preload/api';
import { DEFAULT_ENV_DENYLIST, isValidEnvPattern, MAX_ENV_PATTERNS } from './commands/env';
import { isUsablePath, loginEnvOnce, withPath, type LoginEnv } from './commands/login-env';
import { CommandRunner } from './commands/runner';
import { CommandService } from './commands/service';
import { installNote, suggestAllowlist, suggestInstall } from './commands/suggest';
import { guardIpc, type IpcChannel } from './ipc';
import { lockDownContents, lockDownSession } from './lockdown';
import { securePrivateData } from './perms';
import { DEFAULT_GATED_FILES, GatedFiles, guardedFiles, ModeState } from './policy';
import { DEFAULT_DENYLIST } from './project/sandbox';
import { ProjectService } from './project/service';
import { Pairing } from './server/pairing';
import { createBridgeServer, type BridgeServer } from './server/server';
import { fileTokenStore, loadServerKey } from './server/token-store';
import {
  isValidAllowlist,
  isValidDenyPattern,
  MAX_DENY_PATTERNS,
  MAX_RETENTION_DAYS,
  settingsFile,
  THEMES,
  type Theme,
  type WindowBounds
} from './settings';
import { Updates, updatesOff } from './updates';
import { createWindowOptions } from './window';

// One Bridge at a time: a second launch (from the Dock, say) focuses the first one's window.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

let mainWindow: BrowserWindow | null = null;
let pairing: Pairing;
let server: BridgeServer;
let projects: ProjectService;
let settings: ReturnType<typeof settingsFile>;
let modes: ModeState;
let gated: GatedFiles;
let runner: CommandRunner;
let commands: CommandService;
let serverFailed = false;
let updates: Updates;
let expiryTimer: NodeJS.Timeout | undefined;
/** The project the last change saw, to notice a switch. */
let lastRoot: string | null = null;
/** Allowlist suggestions for the open project, until it has a confirmed list. */
let suggestions: string[] = [];
/** The open project's install command (`npm install`, …), or null without a package.json. */
let installCommand: string | null = null;
let running: RunningCommand | null = null;
/** Which loop run each command belongs to, for grouping its activity row. */
const runLoops = new Map<string, string>();
let loop: LoopReport | null = null;
/** New every launch, so the extension can tell the app restarted. */
const instance = randomUUID();
/** Recent commands' full results, for Activity's detail view, while the app is open. */
const runDetails = new Map<string, RunResult>();
const MAX_RUN_DETAILS = 50;
const DAY_MS = 24 * 60 * 60_000;
/** The login shell's PATH, read once per launch (macOS, Linux). */
const loginEnv = loginEnvOnce();
let login: LoginEnv | null = null;

function commandPath(): CommandPath {
  const override = settings.read().pathOverride;
  if (override) return { source: 'override', path: override, override };
  if (!login) return { source: null, path: process.env.PATH ?? '', override };
  return { ...login, override };
}

function allowlist(): string[] | null {
  const key = projects.projectKey;
  return key === null ? null : (settings.read().allowlists[key] ?? null);
}

function runSettings(): RunSettings {
  const { runTimeoutMs, installTimeoutMs, stepLimit, pauseOnFailure, catchUpAfterSleep } =
    settings.read();
  return {
    timeoutMs: runTimeoutMs,
    installTimeoutMs,
    stepLimit,
    pauseOnFailure,
    catchUpAfterSleep
  };
}

/** The one-time "Add `<manager> install`?" note for the open project, or null. */
function pendingInstallNote(): string | null {
  const key = projects.projectKey;
  if (key === null) return null;
  return installNote(installCommand, allowlist(), settings.read().installNoteSeen.includes(key));
}

/** The project answered the install note, or confirmed a list that already considered it. */
function markInstallNoteSeen(key: string): void {
  const seen = settings.read().installNoteSeen;
  if (!seen.includes(key)) settings.update({ installNoteSeen: [...seen, key] });
}

function bridgeConfig(): BridgeConfig {
  const { stepLimit, pauseOnFailure, catchUpAfterSleep } = runSettings();
  return {
    mode: modes.mode,
    allowlist: allowlist() ?? [],
    stepLimit,
    pauseOnFailure,
    catchUpAfterSleep,
    running: runner.current,
    instance
  };
}

function desktopState(): DesktopState {
  const lockedFor = pairing.lockedForMs;
  const saved = settings.read();
  const confirmed = allowlist();
  return {
    status: serverFailed
      ? 'error'
      : (server.protocolAdvice ??
        (!pairing.isPaired ? 'not-paired' : server.connected ? 'connected' : 'connecting')),
    paired: pairing.isPaired,
    port: server.port,
    pairing: pairing.state,
    lockedUntil: lockedFor > 0 ? Date.now() + lockedFor : null,
    project: projects.project,
    recentProjects: projects.recentProjects,
    defaultDenyPatterns: DEFAULT_DENYLIST,
    denyPatterns: projects.denyPatterns,
    mode: modes.mode,
    sessionResets: modes.sessionResets,
    allowlist: confirmed,
    allowlistSuggestions: confirmed === null ? suggestions : [],
    allowlistNote: saved.allowlistNote,
    installNote: pendingInstallNote(),
    defaultGatedPatterns: DEFAULT_GATED_FILES,
    gatedPatterns: saved.gatedPatterns,
    defaultEnvPatterns: DEFAULT_ENV_DENYLIST,
    envPatterns: saved.envPatterns,
    runSettings: runSettings(),
    commandPath: commandPath(),
    running,
    loop,
    watch: projects.watchMode,
    theme: saved.theme,
    backupRetentionDays: saved.backupRetentionDays,
    onboarding: { dismissed: saved.onboardingDismissed, sessionStarted: saved.sessionStarted },
    about: {
      version: app.getVersion(),
      update: updates.state,
      checkOnStart: saved.checkUpdatesOnStart
    }
  };
}

/** Tells the window to do something a menu item asked for. */
function menuAction(action: MenuAction): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC.menu, action);
}

/** Stops the Full auto loop and its command. Reverts nothing; undo is still there. */
function stopLoop(): void {
  server.broadcast(serverMessage(randomUUID(), 'loop_stop', {}));
  runner.cancelAll();
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const about: MenuItemConstructorOptions = isMac
    ? { role: 'about' }
    : {
        label: 'About Bridge',
        click: () =>
          void dialog.showMessageBox({
            message: 'Bridge',
            detail: `Version ${app.getVersion()}`
          })
      };
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => menuAction('settings')
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              about,
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFolder().then(() => menuAction('session'))
        },
        ...(isMac ? [] : [{ type: 'separator' } as const, settingsItem]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Session',
      submenu: [
        { label: 'Session', accelerator: 'CmdOrCtrl+1', click: () => menuAction('session') },
        { label: 'Activity', accelerator: 'CmdOrCtrl+2', click: () => menuAction('activity') },
        { type: 'separator' },
        {
          label: 'Stop Full auto',
          accelerator: 'CmdOrCtrl+.',
          click: () => stopLoop()
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(app.isPackaged
          ? []
          : [{ type: 'separator' } as const, { role: 'toggleDevTools' } as const])
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Getting started', click: () => menuAction('onboarding') },
        ...(isMac ? [] : [about])
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Follows the Appearance setting in native dialogs and menus too. */
function applyTheme(theme: Theme): void {
  nativeTheme.themeSource = theme;
}

function broadcast(): void {
  mainWindow?.webContents.send(IPC.status, desktopState());
}

function broadcastActivity(): void {
  mainWindow?.webContents.send(IPC.activity, projects.activity());
}

/** Mode, allowlist, settings or the running command changed: tell the window and the extension. */
function configChanged(): void {
  broadcast();
  server?.pushStatus();
}

/** Full auto ends, and whatever is running stops. On unpairing or a project switch. */
function leaveFullAuto(): void {
  modes.dropFullAuto();
  runner.cancelAll();
}

/** A chat session started or ended: Full auto is per session, so it ends with a toast. */
function sessionBoundary(): void {
  if (!modes.noteSession()) return;
  runner.cancelAll();
  broadcast();
}

/** Project switched or settings changed: tell the window and the extension. */
function projectChanged(): void {
  const root = projects.root;
  if (root !== lastRoot) {
    lastRoot = root;
    // A different project ends Full auto, and whatever was running there stops.
    modes.noteProject(root);
    runner.cancelAll();
    loop = null;
    suggestions = [];
    installCommand = null;
    if (root !== null) {
      void projects.readText('package.json').then((text) => {
        if (projects.root !== root) return;
        const has = (file: string) => existsSync(join(root, file));
        suggestions = suggestAllowlist(text, has);
        installCommand = suggestInstall(text, has);
        broadcast();
      });
    }
  }
  configChanged();
}

/**
 * Only our own window's top frame may call in, and only with arguments of the channel's
 * shape (`IPC_ARGS`). Handlers still check what the arguments mean.
 */
function handle<T>(channel: (typeof IPC)[IpcChannel], fn: (...args: unknown[]) => T): void {
  const name = (Object.keys(IPC) as IpcChannel[]).find((key) => IPC[key] === channel)!;
  const guarded = guardIpc(name, ownFrame, fn);
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
    guarded(event, ...args)
  );
}

/** The app window's contents and top frame: the only caller IPC accepts. */
const ownFrame = () =>
  mainWindow ? { sender: mainWindow.webContents, frame: mainWindow.webContents.mainFrame } : null;

async function openFolder(): Promise<OpenFolderResult> {
  if (!mainWindow) return { ok: false, reason: 'cancelled' };
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project folder',
    properties: ['openDirectory', 'createDirectory']
  });
  const [dir] = filePaths;
  if (canceled || dir === undefined) return { ok: false, reason: 'cancelled' };
  const result = await projects.open(dir);
  return result.ok ? { ok: true } : result;
}

/** Undo from the app. If the file changed since the write, the user confirms first. */
async function undoFromApp(opId: string | null): Promise<UndoOutcome> {
  if (opId === null) return { ok: false, code: 'unknown-op' };
  let outcome = await projects.undo(opId);
  if (!outcome.ok && outcome.error.code === 'conflict' && mainWindow) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: `${projects.pathOf(opId) ?? 'This file'} changed after Bridge wrote it.`,
      detail: 'Undoing now replaces those newer changes with the version from before the write.',
      buttons: ['Cancel', 'Undo anyway'],
      defaultId: 0,
      cancelId: 0
    });
    if (response !== 1) return { ok: false, code: 'cancelled' };
    outcome = await projects.undo(opId, { force: true });
  }
  return outcome.ok ? { ok: true } : { ok: false, code: outcome.error.code };
}

/**
 * Full auto needs a plain-words confirmation every time it's turned on, in a native dialog
 * the renderer can't skip.
 */
async function setMode(mode: unknown): Promise<Mode> {
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) return modes.mode;
  if (mode === 'full-auto' && modes.mode !== 'full-auto') {
    if (!mainWindow) return modes.mode;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: 'Turn on Full auto?',
      detail: [
        'Bridge will apply edits, run allowlisted commands and send the next message to the chat on its own, until the chat says it’s done, you press Stop, or it reaches the step limit.',
        '• Automating the chat this way may break its provider’s terms of use and put your account at risk.',
        '• The commands run code the model may have written, such as tests and build scripts, with your user’s permissions.',
        '• This is opt-in and at your own risk. Full auto turns off when you restart Bridge, end the session, unpair or switch projects.'
      ].join('\n\n'),
      buttons: ['Cancel', 'Turn on Full auto'],
      defaultId: 0,
      cancelId: 0
    });
    if (response !== 1) return modes.mode;
  }
  modes.set(mode as Mode);
  return modes.mode;
}

const isUniqueList = (list: string[]) => new Set(list).size === list.length;

function saveList(
  value: unknown,
  valid: (entry: unknown) => boolean,
  max: number,
  save: (list: string[]) => void
): SaveListResult {
  if (!Array.isArray(value) || value.length > max) return { ok: false, invalid: null };
  const bad = value.find((entry) => !valid(entry));
  if (bad !== undefined) return { ok: false, invalid: typeof bad === 'string' ? bad : null };
  const list = value as string[];
  save(isUniqueList(list) ? list : [...new Set(list)]);
  return { ok: true };
}

function registerIpc(): void {
  handle(IPC.getStatus, desktopState);
  handle(IPC.startPairing, () => {
    const code = pairing.startPairing();
    // Tell the UI when the code lapses so it can drop the countdown.
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(broadcast, code.expiresAt - Date.now() + 50);
    broadcast();
    return code;
  });
  handle(IPC.confirmPairing, () => {
    const confirmed = pairing.confirmFingerprint();
    broadcast();
    return confirmed;
  });
  handle(IPC.cancelPairing, () => {
    pairing.cancelPairing();
    broadcast();
  });
  handle(IPC.unpair, () => {
    server.unpair();
  });
  handle(IPC.openFolder, openFolder);
  handle(IPC.openRecent, async (index): Promise<OpenFolderResult> => {
    if (!Number.isInteger(index)) return { ok: false, reason: 'not-a-directory' };
    const result = await projects.openRecent(index as number);
    if (!result) return { ok: false, reason: 'not-a-directory' };
    return result.ok ? { ok: true } : result;
  });
  handle(IPC.getActivity, () => projects.activity());
  handle(IPC.undo, (opId) => undoFromApp(OpId.safeParse(opId).success ? (opId as string) : null));
  handle(IPC.undoLast, () => undoFromApp(projects.lastUndoable()));
  handle(IPC.setDenyPatterns, async (patterns) => {
    if (
      !Array.isArray(patterns) ||
      patterns.length > MAX_DENY_PATTERNS ||
      !patterns.every(isValidDenyPattern)
    ) {
      return false;
    }
    await projects.setDenyPatterns([...new Set(patterns)]);
    return true;
  });
  handle(IPC.setMode, setMode);
  handle(IPC.setAllowlist, (entries): SaveListResult => {
    const key = projects.projectKey;
    if (key === null) return { ok: false, invalid: null };
    if (!isValidAllowlist(entries)) {
      const bad = Array.isArray(entries) ? entries.find((e) => !isValidAllowlist([e])) : undefined;
      return { ok: false, invalid: typeof bad === 'string' ? bad : null };
    }
    const saved = settings.read();
    // A list confirmed from the suggestions already had the install command to pick.
    if (saved.allowlists[key] === undefined) markInstallNoteSeen(key);
    const allowlists = { ...saved.allowlists, [key]: [...new Set(entries)] };
    settings.update({ allowlists });
    configChanged();
    return { ok: true };
  });
  handle(IPC.setGatedPatterns, (patterns) =>
    saveList(patterns, isValidDenyPattern, MAX_DENY_PATTERNS, (list) => {
      settings.update({ gatedPatterns: list });
      gated = new GatedFiles(list);
      broadcast();
    })
  );
  handle(IPC.setEnvPatterns, (patterns) =>
    saveList(patterns, isValidEnvPattern, MAX_ENV_PATTERNS, (list) => {
      settings.update({ envPatterns: list });
      broadcast();
    })
  );
  handle(IPC.setRunSettings, (value) => {
    const next = value as Partial<RunSettings> | null;
    if (
      typeof next !== 'object' ||
      next === null ||
      !Number.isInteger(next.timeoutMs) ||
      next.timeoutMs! < MIN_RUN_TIMEOUT_MS ||
      next.timeoutMs! > MAX_RUN_TIMEOUT_MS ||
      !Number.isInteger(next.installTimeoutMs) ||
      next.installTimeoutMs! < MIN_RUN_TIMEOUT_MS ||
      next.installTimeoutMs! > MAX_RUN_TIMEOUT_MS ||
      !Number.isInteger(next.stepLimit) ||
      next.stepLimit! < 1 ||
      next.stepLimit! > MAX_STEP_LIMIT ||
      typeof next.pauseOnFailure !== 'boolean' ||
      typeof next.catchUpAfterSleep !== 'boolean'
    ) {
      return false;
    }
    settings.update({
      runTimeoutMs: next.timeoutMs!,
      installTimeoutMs: next.installTimeoutMs!,
      stepLimit: next.stepLimit!,
      pauseOnFailure: next.pauseOnFailure,
      catchUpAfterSleep: next.catchUpAfterSleep
    });
    configChanged();
    return true;
  });
  handle(IPC.setPathOverride, (value) => {
    if (typeof value !== 'string') return false;
    const path = value.trim();
    if (path !== '' && !isUsablePath(path)) return false;
    settings.update({ pathOverride: path });
    broadcast();
    return true;
  });
  handle(IPC.cancelRun, () => {
    runner.cancelAll();
  });
  handle(IPC.stopLoop, stopLoop);
  handle(IPC.getOpDetail, (opId) =>
    OpId.safeParse(opId).success ? projects.opDetail(opId as string) : null
  );
  handle(IPC.getRunDetail, (runId): RunDetail | null => {
    const result = RunId.safeParse(runId).success ? runDetails.get(runId as string) : undefined;
    if (!result) return null;
    const { argv, status, exitCode, durationMs, output, truncated } = result;
    return { argv, status, exitCode, durationMs, output, truncated };
  });
  handle(IPC.setTheme, (theme) => {
    if (!THEMES.includes(theme as Theme)) return false;
    settings.update({ theme: theme as Theme });
    applyTheme(theme as Theme);
    broadcast();
    return true;
  });
  handle(IPC.setBackupRetention, async (days) => {
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_RETENTION_DAYS) {
      return false;
    }
    settings.update({ backupRetentionDays: days as number });
    await projects.setRetention((days as number) * DAY_MS);
    broadcast();
    return true;
  });
  handle(IPC.openBackupsFolder, async () => {
    const dir = projects.backupsPath;
    // An empty string means it opened; anything else is the error.
    return dir !== null && (await shell.openPath(dir)) === '';
  });
  handle(IPC.clearBackups, async () => {
    if (!mainWindow || !projects.project) return false;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: `Delete every backup for ${projects.project.name}?`,
      detail:
        'Nothing Bridge changed in this project can be undone afterwards. Your files stay as they are.',
      buttons: ['Cancel', 'Delete backups'],
      defaultId: 0,
      cancelId: 0
    });
    if (response !== 1) return false;
    await projects.clearHistory();
    return true;
  });
  handle(IPC.setOnboardingDismissed, (dismissed) => {
    if (typeof dismissed !== 'boolean') return;
    settings.update({ onboardingDismissed: dismissed });
    broadcast();
  });
  handle(IPC.dismissAllowlistNote, () => {
    settings.update({ allowlistNote: false });
    broadcast();
  });
  handle(IPC.answerInstallNote, (add) => {
    const key = projects.projectKey;
    const entry = pendingInstallNote();
    if (key === null || entry === null) return;
    markInstallNoteSeen(key);
    if (add === true) {
      const list = allowlist() ?? [];
      settings.update({ allowlists: { ...settings.read().allowlists, [key]: [...list, entry] } });
      configChanged();
      return;
    }
    broadcast();
  });
  handle(IPC.checkForUpdates, () => updates.check());
  handle(IPC.setCheckUpdatesOnStart, (on) => {
    if (typeof on !== 'boolean') return;
    settings.update({ checkUpdatesOnStart: on });
    broadcast();
  });
}

/**
 * Build facts the packaging script writes into the packaged package.json (`bridgeBuild`).
 * `updates: false` marks an unsigned macOS build. Missing (dev): nothing to say.
 */
function buildInfo(): { updates: boolean } {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      bridgeBuild?: { updates?: unknown };
    };
    return { updates: pkg.bridgeBuild?.updates !== false };
  } catch {
    return { updates: true };
  }
}

async function startServer(): Promise<void> {
  const userData = app.getPath('userData');
  // userData, the pairing key, settings and backups: private to the user (POSIX).
  await securePrivateData(userData).catch(() => []);
  settings = settingsFile(join(userData, 'settings.json'));
  // Saves any one-time migration (allowlist entries to exact matching) right away.
  settings.update({});
  updates = new Updates({
    off: updatesOff({
      isPackaged: app.isPackaged,
      platform: process.platform,
      buildAllowsUpdates: buildInfo().updates
    }),
    // Loaded on first check only: a build that never checks never loads it.
    load: async () => (await import('electron-updater')).autoUpdater,
    onChange: () => broadcast()
  });
  void loginEnv().then((result) => {
    login = result;
    broadcast();
  });
  modes = new ModeState(settings, configChanged);
  gated = new GatedFiles(settings.read().gatedPatterns);
  runner = new CommandRunner({
    onOutput: (runId, text) => {
      server.broadcast(serverMessage(randomUUID(), 'run_output', { runId, chunk: text }));
      mainWindow?.webContents.send(IPC.runOutput, { runId, text });
    },
    onExit: (result) => {
      server.broadcast(serverMessage(randomUUID(), 'run_exit', result));
      const loopId = runLoops.get(result.runId);
      runLoops.delete(result.runId);
      runDetails.set(result.runId, result);
      if (runDetails.size > MAX_RUN_DETAILS) runDetails.delete(runDetails.keys().next().value!);
      projects.record({
        kind: 'run',
        path: formatArgv(result.argv),
        op: 'run',
        runId: result.runId,
        run: { status: result.status, exitCode: result.exitCode, durationMs: result.durationMs },
        ...(loopId && { loopId, trigger: 'auto' as const })
      });
    },
    onChange: () => {
      const current = runner.current;
      running = current
        ? { runId: current.runId, command: formatArgv(current.argv), startedAt: Date.now() }
        : null;
      configChanged();
    }
  });
  projects = new ProjectService({
    settings,
    backupsDir: join(userData, 'backups'),
    homeDir: homedir(),
    protectedDirs: [userData],
    onChange: projectChanged,
    onActivity: broadcastActivity,
    onFilesChanged: (paths, overflow) =>
      server?.broadcast(serverMessage(randomUUID(), 'file_changed', { paths, overflow })),
    retentionMs: () => settings.read().backupRetentionDays * DAY_MS
  });
  commands = new CommandService({
    runner,
    root: () => projects.root,
    mode: () => modes.mode,
    allowlist: () => allowlist() ?? [],
    envPatterns: () => settings.read().envPatterns,
    timeoutMs: () => settings.read().runTimeoutMs,
    installTimeoutMs: () => settings.read().installTimeoutMs,
    // Wait for the login shell's PATH on the first run, if it's still being read.
    env: async () => {
      await loginEnv();
      return withPath(process.env, commandPath().path);
    },
    onRefused: (argv, code) =>
      projects.record({ kind: 'failed', op: 'run', path: formatArgv(argv), code })
  });
  await projects.restore();
  // A project folder can vanish without an event (an unmounted disk): check now and then.
  setInterval(() => void projects.checkRoot(), 5_000).unref();
  pairing = new Pairing({
    store: fileTokenStore(join(userData, 'pairing.json'), safeStorage),
    serverKey: loadServerKey(join(userData, 'server-key.json'), safeStorage)
  });
  server = createBridgeServer({
    pairing,
    version: app.getVersion(),
    onChange: broadcast,
    // Writes from the extension: the mode and the gated list come before the sandbox.
    files: guardedFiles(
      projects,
      () => modes.mode,
      () => gated
    ),
    commands: async (request) => {
      if (request.type === 'run_cancel') return commands.cancel(request.payload.runId);
      const outcome = await commands.run(request.payload);
      if (outcome.ok && request.payload.loopId) {
        runLoops.set(outcome.result.runId, request.payload.loopId);
      }
      return outcome;
    },
    project: () => projects.project,
    config: bridgeConfig,
    onLoopReport: (report) => {
      loop = report;
      if (report.event) {
        projects.record({
          kind: 'loop',
          path: '',
          text: report.event.text,
          loopId: report.loopId,
          trigger: 'auto'
        });
      }
      broadcast();
    },
    onSessionEnd: sessionBoundary,
    onSessionStart: () => {
      sessionBoundary();
      if (settings.read().sessionStarted) return;
      settings.update({ sessionStarted: true });
      broadcast();
    },
    onUnpaired: () => {
      leaveFullAuto();
      loop = null;
    }
  });
  try {
    // The e2e scripts run a dev build on their own range, clear of a `pnpm dev` app.
    const e2e = !app.isPackaged && process.env.BRIDGE_E2E === '1';
    const port = await server.listen(candidatePorts(e2e ? E2E_PORT : DEFAULT_PORT));
    settings.update({ port });
  } catch {
    serverFailed = true;
  }
  broadcast();
}

/** The saved bounds, if they still fit on a connected display. */
function savedBounds(): WindowBounds | undefined {
  const bounds = settings.read().windowBounds;
  if (!bounds) return undefined;
  const { workArea } = screen.getDisplayMatching(bounds);
  const visible =
    bounds.x < workArea.x + workArea.width - 50 &&
    bounds.x + bounds.width > workArea.x + 50 &&
    bounds.y < workArea.y + workArea.height - 50 &&
    bounds.y + bounds.height > workArea.y;
  return visible ? bounds : undefined;
}

function createWindow(): void {
  const bounds = savedBounds();
  const window = new BrowserWindow({
    ...createWindowOptions(join(__dirname, '../preload/index.js')),
    ...(bounds && { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  });
  mainWindow = window;

  window.on('ready-to-show', () => {
    if (bounds?.maximized) window.maximize();
    window.show();
  });
  // The packaging smoke test (scripts/smoke.mjs) launches the app with a temp userData and
  // waits for this file: the window loaded, and the port the server bound.
  if (process.env.BRIDGE_SMOKE_TEST === '1') {
    window.webContents.once('did-finish-load', () =>
      writeFileSync(
        join(app.getPath('userData'), 'smoke.json'),
        JSON.stringify({
          window: true,
          port: server.port,
          version: app.getVersion(),
          name: app.getName()
        })
      )
    );
  }
  // Remember where the window is, a moment after it stops moving.
  let saveTimer: NodeJS.Timeout | undefined;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.isDestroyed() || window.isMinimized()) return;
      const { x, y, width, height } = window.getNormalBounds();
      settings.update({ windowBounds: { x, y, width, height, maximized: window.isMaximized() } });
    }, 500);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    window.on(event as 'resize', saveBounds);
  }
  window.on('closed', () => {
    clearTimeout(saveTimer);
    if (mainWindow === window) mainWindow = null;
  });

  // Navigation, new windows and webviews are refused for every web contents
  // (`web-contents-created` below), this window's included.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.on('second-instance', () => {
  if (!mainWindow) {
    if (app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// Every renderer runs in the Chromium sandbox, whatever a window's own options say.
app.enableSandbox();
// No web contents may navigate away, open a window or attach a <webview>.
app.on('web-contents-created', (_event, contents) =>
  lockDownContents(contents, (url) => void shell.openExternal(url))
);

app.setAboutPanelOptions({
  applicationName: 'Bridge',
  applicationVersion: app.getVersion(),
  version: '',
  copyright: 'Runs only on this computer.'
});

void app.whenReady().then(async () => {
  if (!primary) return;
  // The renderer needs no camera, notifications, clipboard, etc.: every request and
  // check is refused.
  lockDownSession(session.defaultSession);

  // safeStorage needs the app to be ready, so the server starts here.
  await startServer();
  applyTheme(settings.read().theme);
  registerIpc();
  buildMenu();
  createWindow();
  // Only if the user asked for it (Settings → About). Notify only.
  if (settings.read().checkUpdatesOnStart) void updates.check();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  clearTimeout(expiryTimer);
  // A running command is in its own process group; take it down with the app.
  runner?.cancelAll();
  void projects?.close();
  void server?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
