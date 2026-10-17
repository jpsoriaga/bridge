import type { BrowserWindowConstructorOptions } from 'electron';

// Kept free of runtime Electron imports so the security settings can be unit tested.
export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1080,
    height: 720,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Bridge',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  };
}
