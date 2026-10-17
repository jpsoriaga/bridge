import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { candidatePorts, OpId } from '@bridge/shared';
import { IPC, type DesktopState, type OpenFolderResult, type UndoOutcome } from '../preload/api';
import { DEFAULT_DENYLIST } from './project/sandbox';
import { ProjectService } from './project/service';
import { Pairing } from './server/pairing';
import { createBridgeServer, type BridgeServer } from './server/server';
import { fileTokenStore } from './server/token-store';
import { isValidDenyPattern, MAX_DENY_PATTERNS, settingsFile } from './settings';
import { createWindowOptions } from './window';

let mainWindow: BrowserWindow | null = null;
let pairing: Pairing;
let server: BridgeServer;
let projects: ProjectService;
let serverFailed = false;
let expiryTimer: NodeJS.Timeout | undefined;

function desktopState(): DesktopState {
  const lockedFor = pairing.lockedForMs;
  return {
    status: serverFailed
      ? 'error'
      : !pairing.isPaired
        ? 'not-paired'
        : server.connected
          ? 'connected'
          : 'connecting',
    paired: pairing.isPaired,
    port: server.port,
    pairing: pairing.pendingCode,
    lockedUntil: lockedFor > 0 ? Date.now() + lockedFor : null,
    project: projects.project,
    recentProjects: projects.recentProjects,
    defaultDenyPatterns: DEFAULT_DENYLIST,
    denyPatterns: projects.denyPatterns
  };
}

function broadcast(): void {
  mainWindow?.webContents.send(IPC.status, desktopState());
}

function broadcastActivity(): void {
  mainWindow?.webContents.send(IPC.activity, projects.activity());
}

/** Project switched or settings changed: tell the window and the extension. */
function projectChanged(): void {
  broadcast();
  server?.pushStatus();
}

/** Only our own window's top frame may call in. Arguments are untrusted until checked. */
function handle<T>(channel: string, fn: (...args: unknown[]) => T): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Unknown sender');
    }
    if (event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Unknown frame');
    }
    return fn(...args);
  });
}

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
}

async function startServer(): Promise<void> {
  const userData = app.getPath('userData');
  const settings = settingsFile(join(userData, 'settings.json'));
  projects = new ProjectService({
    settings,
    backupsDir: join(userData, 'backups'),
    homeDir: homedir(),
    protectedDirs: [userData],
    onChange: projectChanged,
    onActivity: broadcastActivity
  });
  await projects.restore();
  pairing = new Pairing({ store: fileTokenStore(join(userData, 'pairing.json'), safeStorage) });
  server = createBridgeServer({
    pairing,
    version: app.getVersion(),
    onChange: broadcast,
    files: (request) => projects.handle(request),
    project: () => projects.project
  });
  try {
    const port = await server.listen(candidatePorts());
    settings.update({ port });
  } catch {
    serverFailed = true;
  }
  broadcast();
}

function createWindow(): void {
  const window = new BrowserWindow(createWindowOptions(join(__dirname, '../preload/index.js')));
  mainWindow = window;

  window.on('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Never open new windows or navigate away from the app. https links go to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(async () => {
  // The renderer needs no camera, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  );

  // safeStorage needs the app to be ready, so the server starts here.
  await startServer();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  clearTimeout(expiryTimer);
  void server?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
