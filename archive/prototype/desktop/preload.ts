import { contextBridge, ipcRenderer } from 'electron';

export interface BridgeElectronApi {
  selectWorkspace: () => Promise<{ path: string | null; canceled: boolean }>;
  getWorkspace: () => Promise<{ workspace: string | null }>;
  undoLast: () => Promise<{ success: boolean; batchId?: string; revertedFiles: string[] }>;
  getPairingInfo: () => Promise<{ port: number; token: string }>;
  regeneratePairingToken: () => Promise<{ port: number; token: string }>;
  runCommand: (
    executable: string,
    args: string[]
  ) => Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode?: number;
    error?: string;
  }>;
}

const api: BridgeElectronApi = {
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  undoLast: () => ipcRenderer.invoke('history:undo'),
  getPairingInfo: () => ipcRenderer.invoke('pairing:get'),
  regeneratePairingToken: () => ipcRenderer.invoke('pairing:regenerate'),
  runCommand: (executable: string, args: string[]) => ipcRenderer.invoke('command:run', executable, args)
};

try {
  contextBridge.exposeInMainWorld('bridgeApi', api);
} catch (error) {
  console.error('Failed to expose bridgeApi via contextBridge:', error);
}
