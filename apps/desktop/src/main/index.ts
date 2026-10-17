import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent
} from 'electron';
import { join } from 'node:path';
import { candidatePorts } from '@bridge/shared';
import { IPC, type DesktopState } from '../preload/api';
import { Pairing } from './server/pairing';
import { createBridgeServer, type BridgeServer } from './server/server';
import { fileTokenStore } from './server/token-store';
import { settingsFile } from './settings';
import { createWindowOptions } from './window';

let mainWindow: BrowserWindow | null = null;
let pairing: Pairing;
let server: BridgeServer;
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
    lockedUntil: lockedFor > 0 ? Date.now() + lockedFor : null
  };
}

function broadcast(): void {
  mainWindow?.webContents.send(IPC.status, desktopState());
}

/** Only our own window's top frame may call in. */
function handle<T>(channel: string, fn: () => T): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Unknown sender');
    }
    if (event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Unknown frame');
    }
    return fn();
  });
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
}

async function startServer(): Promise<void> {
  const userData = app.getPath('userData');
  const settings = settingsFile(join(userData, 'settings.json'));
  pairing = new Pairing({ store: fileTokenStore(join(userData, 'pairing.json'), safeStorage) });
  server = createBridgeServer({ pairing, version: app.getVersion(), onChange: broadcast });
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
