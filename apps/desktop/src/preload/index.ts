import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type BridgeApi, type DesktopState, type PairingCode } from './api';

declare const __BRIDGE_VERSION__: string;

// Each method maps to one fixed channel and takes no arguments from the page.
const api: BridgeApi = {
  version: __BRIDGE_VERSION__,
  getStatus: () => ipcRenderer.invoke(IPC.getStatus) as Promise<DesktopState>,
  onStatus: (listener) => {
    // Drop the event object so the page never sees ipcRenderer internals.
    const handler = (_event: IpcRendererEvent, state: DesktopState) => listener(state);
    ipcRenderer.on(IPC.status, handler);
    return () => {
      ipcRenderer.removeListener(IPC.status, handler);
    };
  },
  startPairing: () => ipcRenderer.invoke(IPC.startPairing) as Promise<PairingCode>,
  unpair: () => ipcRenderer.invoke(IPC.unpair) as Promise<void>
};

contextBridge.exposeInMainWorld('bridge', api);
