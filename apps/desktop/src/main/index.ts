import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerIpcHandlers } from './ipc/handlers';
import { localServer } from './server/local-server';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Bridge',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: process.env.NODE_ENV !== 'production'
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open external links safely in browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // Load the remote URL for dev or local html for production
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  registerIpcHandlers(mainWindow);
}

app.whenReady().then(async () => {
  // Start local Fastify server bound to 127.0.0.1
  try {
    await localServer.start();
  } catch (err) {
    console.error('Failed to start local server:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  await localServer.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
