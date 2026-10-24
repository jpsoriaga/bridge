import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions
} from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  candidatePorts,
  DEFAULT_PORT,
  defaultChannel,
  E2E_PORT,
  formatArgv,
  isLocalUrl,
  looksLikeBackground,
  MAX_RUN_TIMEOUT_MS,
  MAX_STEP_LIMIT,
  MIN_RUN_TIMEOUT_MS,
  MODES,
  OpId,
  RunId,
  serverMessage,
  UI_GUIDANCE,
  type BridgeConfig,
  type LoopReport,
  type Mode,
  type RunResult,
  type UiGuidance,
  type UpdateChannel
} from '@bridge/shared';
import {
  IPC,
  type CommandPath,
  type ActivityEntry,
  type AutoApproveSettings,
  type DesktopState,
  type MenuAction,
  type OpenFolderResult,
  type RunDetail,
  type RunningCommand,
  type RunSettings,
  type SaveListResult,
  type UndoOutcome
} from '../preload/api';
import { BackgroundRunner } from './commands/background';
import { BackgroundLifecycle } from './commands/lifecycle';
import { DEFAULT_ENV_DENYLIST, isValidEnvPattern, MAX_ENV_PATTERNS } from './commands/env';
import { isUsablePath, loginEnvOnce, withPath, type LoginEnv } from './commands/login-env';
import { CommandRunner } from './commands/runner';
import { CommandService } from './commands/service';
import { backgroundNote, installNote, suggestAllowlist, suggestInstall } from './commands/suggest';
import { appDiagnostics } from './diagnostics';
import { guardIpc, type IpcChannel } from './ipc';
import { lockDownContents, lockDownSession } from './lockdown';
import { Log } from './log';
import { PRIVATE_DIR_MODE, securePrivateData } from './perms';
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
let processes: BackgroundRunner;
let lifecycle: BackgroundLifecycle;
let commands: CommandService;
let serverFailed = false;
let updates: Updates;
let log: Log;
/** Goes up each time diagnostics are copied, for the window's toast. */
let diagnosticsCopied = 0;
/** The connection status last logged, to log only changes. */
let loggedStatus: string | null = null;
/** The newest Activity row already logged, and the rows already logged as undone. */
let loggedActivity: string | null = null;
const loggedUndone = new Set<string>();
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
/** Each background process's state when last seen, to log what changed. */
const processStates = new Map<string, string>();
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

/**
 * The open project's background entries: the saved ones once its list is confirmed, or
 * the suggestions that look like dev servers before then.
 */
function backgroundEntries(): string[] {
  const key = projects.projectKey;
  if (key === null) return [];
  const confirmed = allowlist();
  if (confirmed === null) return suggestions.filter(looksLikeBackground);
  return (settings.read().backgroundAllowlists[key] ?? []).filter((e) => confirmed.includes(e));
}

/** The channel the user picked, or this build's own (beta builds check for betas). */
function updateChannel(): UpdateChannel {
  return settings.read().updateChannel ?? defaultChannel(app.getVersion());
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

/** The one-time "Add `npm run dev` as a background command?" note, or null. */
function pendingBackgroundNote(): string | null {
  const key = projects.projectKey;
  if (key === null) return null;
  const seen = settings.read().backgroundNoteSeen.includes(key);
  return backgroundNote(suggestions, allowlist(), backgroundEntries(), seen);
}

function markBackgroundNoteSeen(key: string): void {
  const seen = settings.read().backgroundNoteSeen;
  if (!seen.includes(key)) settings.update({ backgroundNoteSeen: [...seen, key] });
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
    background: allowlist() === null ? [] : backgroundEntries(),
    processes: processes.list(),
    autoApprove: settings.read().autoApprove,
    uiGuidance: settings.read().uiGuidance,
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
    background: backgroundEntries(),
    processes: processes.list(),
    autoApprove: saved.autoApprove,
    unlimitedNoteSeen: saved.unlimitedNoteSeen,
    allowlistNote: saved.allowlistNote,
    installNote: pendingInstallNote(),
    backgroundNote: pendingBackgroundNote(),
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
    uiGuidance: saved.uiGuidance,
    backupRetentionDays: saved.backupRetentionDays,
    onboarding: { dismissed: saved.onboardingDismissed, sessionStarted: saved.sessionStarted },
    about: {
      version: app.getVersion(),
      update: updates.state,
      checkOnStart: saved.checkUpdatesOnStart,
      channel: updateChannel(),
      defaultChannel: defaultChannel(app.getVersion()),
      diagnosticsCopied
    }
  };
}

/** Help → Copy diagnostics: versions, states and the last log lines, redacted. */
function copyDiagnostics(): boolean {
  const state = desktopState();
  clipboard.writeText(
    appDiagnostics({
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      osVersion: process.getSystemVersion(),
      browser: server.browser,
      status: state.status,
      paired: state.paired,
      port: state.port,
      mode: state.mode,
      project: projects.root,
      updateChannel: updateChannel(),
      log: log.recent(),
      home: homedir(),
      time: new Date()
    })
  );
  diagnosticsCopied += 1;
  log.info('diagnostics copied');
  broadcast();
  return true;
}

/** Help → Open logs folder. */
async function openLogsFolder(): Promise<boolean> {
  try {
    mkdirSync(log.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch {
    return false;
  }
  // An empty string means it opened; anything else is the error.
  return (await shell.openPath(log.dir)) === '';
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
        { type: 'separator' },
        { label: 'Copy diagnostics', click: () => copyDiagnostics() },
        { label: 'Open logs folder', click: () => void openLogsFolder() },
        ...(isMac ? [] : [{ type: 'separator' } as const, about])
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
  const state = desktopState();
  if (state.status !== loggedStatus) {
    log.info(`connection: ${state.status}`);
    loggedStatus = state.status;
  }
  mainWindow?.webContents.send(IPC.status, state);
}

function broadcastActivity(): void {
  const entries = projects.activity();
  logActivity(entries);
  mainWindow?.webContents.send(IPC.activity, entries);
}

/** New Activity rows, as one log line each: what happened to which path, never contents. */
function logActivity(entries: ActivityEntry[]): void {
  const newest = entries[0]?.id ?? null;
  const fresh: ActivityEntry[] = [];
  for (const entry of entries) {
    if (entry.id === loggedActivity) break;
    fresh.push(entry);
  }
  // The first list after opening a project is history, not news.
  const first = loggedActivity === null;
  loggedActivity = newest;
  const undone = entries.filter((e) => e.undone && !loggedUndone.has(e.id));
  for (const entry of undone) loggedUndone.add(entry.id);
  if (first) return;
  for (const entry of undone) {
    if (!fresh.includes(entry)) log.info(`activity: undone ${entry.kind} ${entry.path}`);
  }
  for (const entry of fresh.reverse()) {
    const how = [entry.source && `via ${entry.source}`, entry.trigger, entry.undone && 'undone']
      .filter(Boolean)
      .join(', ');
    const what =
      entry.kind === 'rejected' || entry.kind === 'failed'
        ? `refused ${entry.op ?? 'request'} ${entry.path}: ${entry.code ?? 'error'}`
        : entry.kind === 'run'
          ? `command ${entry.path}: ${entry.run?.status ?? 'done'}${entry.run?.exitCode != null ? ` (exit ${entry.run.exitCode})` : ''}${entry.run ? `, ${entry.run.durationMs} ms` : ''}`
          : entry.kind === 'loop'
            ? `full auto: ${entry.text ?? ''}`
            : `${entry.kind} ${entry.from ? `${entry.from} -> ` : ''}${entry.path}`;
    const level = entry.kind === 'rejected' || entry.kind === 'failed' ? 'warn' : 'info';
    log[level](`activity: ${what}${how ? ` (${how})` : ''}`);
  }
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

/** A background process started, found its URL, or ended: the log and Activity hear of it. */
function processesChanged(): void {
  for (const proc of processes.list()) {
    const state = `${proc.state}:${proc.url ?? ''}`;
    if (processStates.get(proc.procId) === state) continue;
    const first = !processStates.has(proc.procId);
    processStates.set(proc.procId, state);
    const what =
      proc.state === 'running'
        ? first
          ? 'started'
          : `ready at ${proc.url}`
        : proc.state === 'stopped'
          ? 'stopped'
          : `exited${proc.exitCode !== null ? ` (exit ${proc.exitCode})` : proc.signal ? ` (${proc.signal})` : ''}`;
    log.info(`background ${proc.command}: ${what}`);
    if (proc.state !== 'running' || first) {
      projects.record({ kind: 'process', path: proc.command, text: what });
    }
  }
  configChanged();
}

/** Project switched or settings changed: tell the window and the extension. */
function projectChanged(): void {
  const root = projects.root;
  if (root !== lastRoot) {
    lastRoot = root;
    log.info(root === null ? 'project closed' : `project opened ${root}`);
    loggedActivity = null;
    loggedUndone.clear();
    // A different project ends Full auto, and whatever was running there stops.
    modes.noteProject(root);
    runner.cancelAll();
    void lifecycle.projectSwitched();
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

/**
 * Full auto → "Also approve automatically". Turning any of them on asks in a native dialog
 * that says plainly what it means; the renderer can't skip it. Turning them off never asks.
 */
async function setAutoApprove(value: AutoApproveSettings): Promise<AutoApproveSettings> {
  const current = settings.read().autoApprove;
  const next = { changes: value.changes, gated: value.gated, partial: value.partial };
  const added = (Object.keys(next) as (keyof AutoApproveSettings)[]).filter(
    (key) => next[key] && !current[key]
  );
  if (added.length > 0) {
    if (!mainWindow) return current;
    const risks: Record<keyof AutoApproveSettings, string> = {
      changes:
        '• Deletes and renames: Full auto deletes and moves files the chat names, without asking.',
      gated:
        '• Gated files: Full auto changes package.json, lockfiles, CI workflows and git hooks, which decide what commands like npm install and npm test run.',
      partial:
        '• Partial-looking files: Full auto writes files that look cut short (“…rest unchanged”), which can replace a whole file with part of it.'
    };
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: 'Let Full auto do these without asking?',
      detail: [
        ...added.map((key) => risks[key]),
        'Each change is backed up first, so Undo in the app or on its card puts it back. Commands off the allowlist, downloads, protected files and files changed on disk still wait for you.'
      ].join('\n\n'),
      buttons: ['Cancel', 'Approve automatically'],
      defaultId: 0,
      cancelId: 0
    });
    if (response !== 1) return current;
  }
  settings.update({ autoApprove: next });
  log.info(
    `full auto approves automatically: ${(Object.keys(next) as (keyof AutoApproveSettings)[]).filter((k) => next[k]).join(', ') || 'nothing extra'}`
  );
  configChanged();
  return next;
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
    // Never the code itself.
    log.info('pairing: code shown');
    const code = pairing.startPairing();
    // Tell the UI when the code lapses so it can drop the countdown.
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(broadcast, code.expiresAt - Date.now() + 50);
    broadcast();
    return code;
  });
  handle(IPC.confirmPairing, () => {
    const confirmed = pairing.confirmFingerprint();
    log.info(
      `pairing: fingerprint ${confirmed ? 'confirmed in the app' : 'not confirmed (expired)'}`
    );
    broadcast();
    return confirmed;
  });
  handle(IPC.cancelPairing, () => {
    log.info('pairing: cancelled in the app');
    pairing.cancelPairing();
    broadcast();
  });
  handle(IPC.unpair, () => {
    log.info('unpaired in the app');
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
  handle(IPC.setMode, async (mode) => {
    const next = await setMode(mode);
    log.info(`mode: ${next}`);
    return next;
  });
  handle(IPC.setAllowlist, (entries): SaveListResult => {
    const key = projects.projectKey;
    if (key === null) return { ok: false, invalid: null };
    if (!isValidAllowlist(entries)) {
      const bad = Array.isArray(entries) ? entries.find((e) => !isValidAllowlist([e])) : undefined;
      return { ok: false, invalid: typeof bad === 'string' ? bad : null };
    }
    const saved = settings.read();
    const previous = saved.allowlists[key];
    // A list confirmed from the suggestions already had the install command to pick.
    if (previous === undefined) {
      markInstallNoteSeen(key);
      markBackgroundNoteSeen(key);
    }
    const list = [...new Set(entries)];
    // Background entries stay as they were; a new one that looks like a dev server
    // (`npm run dev`) starts out as one. The user can change either in Settings.
    const kept = backgroundEntries().filter((entry) => list.includes(entry));
    const added = list.filter((entry) => !previous?.includes(entry) && looksLikeBackground(entry));
    settings.update({
      allowlists: { ...saved.allowlists, [key]: list },
      backgroundAllowlists: {
        ...saved.backgroundAllowlists,
        [key]: [...new Set([...kept, ...added])]
      }
    });
    configChanged();
    return { ok: true };
  });
  handle(IPC.setBackgroundEntries, (entries): SaveListResult => {
    const key = projects.projectKey;
    const confirmed = allowlist();
    if (key === null || confirmed === null || !Array.isArray(entries)) {
      return { ok: false, invalid: null };
    }
    const bad = entries.find((entry) => typeof entry !== 'string' || !confirmed.includes(entry));
    if (bad !== undefined) return { ok: false, invalid: typeof bad === 'string' ? bad : null };
    const saved = settings.read();
    settings.update({
      backgroundAllowlists: {
        ...saved.backgroundAllowlists,
        [key]: [...new Set(entries as string[])]
      }
    });
    configChanged();
    return { ok: true };
  });
  handle(IPC.setAutoApprove, (value) => setAutoApprove(value as AutoApproveSettings));
  handle(IPC.dismissUnlimitedNote, () => {
    settings.update({ unlimitedNoteSeen: true });
    broadcast();
  });
  handle(IPC.stopProcess, async (procId) => {
    if (typeof procId !== 'string') return false;
    return processes.stop({ procId });
  });
  handle(IPC.getProcessLogs, (procId) =>
    typeof procId === 'string' ? processes.logs({ procId }, { tail: 2_000 }) : null
  );
  handle(IPC.openProcessUrl, async (procId) => {
    const url = typeof procId === 'string' ? processes.find({ procId })?.url : null;
    // Only ever a URL on this computer that the process itself printed.
    if (!url || !isLocalUrl(url)) return false;
    await shell.openExternal(url);
    return true;
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
      (next.stepLimit !== null &&
        (!Number.isInteger(next.stepLimit) ||
          next.stepLimit! < 1 ||
          next.stepLimit! > MAX_STEP_LIMIT)) ||
      typeof next.pauseOnFailure !== 'boolean' ||
      typeof next.catchUpAfterSleep !== 'boolean'
    ) {
      return false;
    }
    settings.update({
      runTimeoutMs: next.timeoutMs!,
      installTimeoutMs: next.installTimeoutMs!,
      stepLimit: next.stepLimit ?? null,
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
  handle(IPC.setUiGuidance, (value) => {
    if (!UI_GUIDANCE.includes(value as UiGuidance)) return false;
    settings.update({ uiGuidance: value as UiGuidance });
    configChanged();
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
  handle(IPC.answerBackgroundNote, (add) => {
    const key = projects.projectKey;
    const entry = pendingBackgroundNote();
    if (key === null || entry === null) return;
    markBackgroundNoteSeen(key);
    if (add === true) {
      const saved = settings.read();
      const list = allowlist() ?? [];
      settings.update({
        allowlists: { ...saved.allowlists, [key]: [...new Set([...list, entry])] },
        backgroundAllowlists: {
          ...saved.backgroundAllowlists,
          [key]: [...new Set([...backgroundEntries(), entry])]
        }
      });
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
  handle(IPC.setUpdateChannel, (channel) => {
    if (channel !== 'stable' && channel !== 'beta') return;
    settings.update({ updateChannel: channel });
    log.info(`update channel: ${channel}`);
    broadcast();
  });
  handle(IPC.copyDiagnostics, copyDiagnostics);
  handle(IPC.openLogsFolder, openLogsFolder);
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
  // userData, the pairing key, settings, backups and logs: private to the user (POSIX).
  await securePrivateData(userData).catch(() => []);
  log = new Log({ dir: join(userData, 'logs'), home: homedir() });
  settings = settingsFile(join(userData, 'settings.json'));
  // Saves any one-time migration (allowlist entries to exact matching) right away.
  settings.update({});
  log.info(
    `Bridge ${app.getVersion()}${app.isPackaged ? '' : ' (development)'} started on ${process.platform} ${process.getSystemVersion()} ${process.arch}, update channel ${updateChannel()}`
  );
  updates = new Updates({
    version: app.getVersion(),
    channel: updateChannel,
    off: updatesOff({
      isPackaged: app.isPackaged,
      platform: process.platform,
      buildAllowsUpdates: buildInfo().updates
    }),
    // Loaded on first check only: a build that never checks never loads it.
    load: async () => (await import('electron-updater')).autoUpdater,
    onChange: (check) => {
      if (check && check.state !== 'checking') {
        log.info(
          `update check: ${check.state}${'version' in check ? ` ${check.version}` : ''}${check.state === 'off' ? ` (${check.reason})` : ''}`
        );
      }
      broadcast();
    }
  });
  void loginEnv().then((result) => {
    login = result;
    if (result.warning) log.warn(`PATH for commands: ${result.source}: ${result.warning}`);
    else log.info(`PATH for commands: from ${result.source}`);
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
  processes = new BackgroundRunner(() => processesChanged());
  lifecycle = new BackgroundLifecycle(processes, (why) =>
    log.info(`background processes stopped: ${why}`)
  );
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
    processes,
    root: () => projects.root,
    mode: () => modes.mode,
    allowlist: () => allowlist() ?? [],
    background: backgroundEntries,
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
      () => gated,
      () => settings.read().autoApprove
    ),
    commands: async (request) => {
      switch (request.type) {
        case 'run_cancel':
          return commands.cancel(request.payload.runId);
        case 'bg_start':
          return commands.start(request.payload);
        case 'bg_stop':
          return commands.stop(request.payload);
        case 'bg_logs':
          return commands.logs(request.payload);
        case 'run': {
          const outcome = await commands.run(request.payload);
          if (outcome.ok && request.payload.loopId) {
            runLoops.set(outcome.result.runId, request.payload.loopId);
          }
          return outcome;
        }
      }
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
    onSessionEnd: () => {
      log.info('chat session ended');
      sessionBoundary();
      void lifecycle.sessionEnded();
    },
    onSessionStart: () => {
      log.info('chat session started');
      sessionBoundary();
      if (settings.read().sessionStarted) return;
      settings.update({ sessionStarted: true });
      broadcast();
    },
    onUnpaired: () => {
      log.info('pairing revoked or replaced');
      leaveFullAuto();
      loop = null;
    }
  });
  try {
    // The e2e scripts run a dev build on their own range, clear of a `pnpm dev` app.
    const e2e = !app.isPackaged && process.env.BRIDGE_E2E === '1';
    const port = await server.listen(candidatePorts(e2e ? E2E_PORT : DEFAULT_PORT));
    settings.update({ port });
    log.info(`server listening on 127.0.0.1:${port}`);
  } catch (error) {
    serverFailed = true;
    log.error(`server failed to start: ${(error as Error).message}`);
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
  // A long sleep ends the dev servers: nobody's been using them, and they hold ports.
  powerMonitor.on('suspend', () => lifecycle.suspended());
  powerMonitor.on('resume', () => void lifecycle.resumed());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', (event) => {
  clearTimeout(expiryTimer);
  // A running command is in its own process group; take it down with the app.
  runner?.cancelAll();
  // Dev servers too, and wait until they're gone (a few seconds at most), so none outlives
  // the app.
  const stopping = lifecycle?.beforeQuit();
  if (stopping) {
    event.preventDefault();
    void stopping.finally(() => app.quit());
    return;
  }
  void projects?.close();
  void server?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
