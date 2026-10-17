import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { commandExecutor } from '../commands/command-executor';
import { configService } from '../services/config.service';
import { historyManager } from '../history/history-manager';
import { securityService } from '../services/security.service';

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Folder selection
  ipcMain.handle('workspace:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Bridge Workspace Folder'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selected = result.filePaths[0]!;
      configService.setSelectedWorkspace(selected);
      return { path: selected, canceled: false };
    }

    return { path: configService.getSelectedWorkspace(), canceled: true };
  });

  // Get current workspace
  ipcMain.handle('workspace:get', () => {
    return {
      workspace: configService.getSelectedWorkspace()
    };
  });

  // Undo last batch
  ipcMain.handle('history:undo', async () => {
    return await historyManager.undoLast();
  });

  // Get pairing details for UI display
  ipcMain.handle('pairing:get', () => {
    return {
      port: configService.getServerPort(),
      token: securityService.getPairingToken()
    };
  });

  // Regenerate pairing token
  ipcMain.handle('pairing:regenerate', () => {
    return {
      port: configService.getServerPort(),
      token: securityService.regeneratePairingToken()
    };
  });

  // Run allowlisted command
  ipcMain.handle('command:run', async (_event, executable: string, args: string[]) => {
    return await commandExecutor.runAllowlistedCommand(executable, args);
  });
}
