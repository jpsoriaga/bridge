import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type ActivityEntry,
  type BridgeApi,
  type DesktopState,
  type OpenFolderResult,
  type PairingCode,
  type SaveListResult,
  type UndoOutcome
} from './api';
import type { Mode } from '@bridge/shared';

declare const __BRIDGE_VERSION__: string;

// Each method maps to one fixed channel. Arguments are plain values that main validates.
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
  unpair: () => ipcRenderer.invoke(IPC.unpair) as Promise<void>,
  openFolder: () => ipcRenderer.invoke(IPC.openFolder) as Promise<OpenFolderResult>,
  openRecent: (index) => ipcRenderer.invoke(IPC.openRecent, index) as Promise<OpenFolderResult>,
  getActivity: () => ipcRenderer.invoke(IPC.getActivity) as Promise<ActivityEntry[]>,
  onActivity: (listener) => {
    const handler = (_event: IpcRendererEvent, entries: ActivityEntry[]) => listener(entries);
    ipcRenderer.on(IPC.activity, handler);
    return () => {
      ipcRenderer.removeListener(IPC.activity, handler);
    };
  },
  undo: (opId) => ipcRenderer.invoke(IPC.undo, opId) as Promise<UndoOutcome>,
  undoLast: () => ipcRenderer.invoke(IPC.undoLast) as Promise<UndoOutcome>,
  setDenyPatterns: (patterns) =>
    ipcRenderer.invoke(IPC.setDenyPatterns, patterns) as Promise<boolean>,
  setMode: (mode) => ipcRenderer.invoke(IPC.setMode, mode) as Promise<Mode>,
  setAllowlist: (entries) =>
    ipcRenderer.invoke(IPC.setAllowlist, entries) as Promise<SaveListResult>,
  setGatedPatterns: (patterns) =>
    ipcRenderer.invoke(IPC.setGatedPatterns, patterns) as Promise<SaveListResult>,
  setEnvPatterns: (patterns) =>
    ipcRenderer.invoke(IPC.setEnvPatterns, patterns) as Promise<SaveListResult>,
  setRunSettings: (settings) =>
    ipcRenderer.invoke(IPC.setRunSettings, settings) as Promise<boolean>,
  setPathOverride: (path) => ipcRenderer.invoke(IPC.setPathOverride, path) as Promise<boolean>,
  cancelRun: () => ipcRenderer.invoke(IPC.cancelRun) as Promise<void>,
  stopLoop: () => ipcRenderer.invoke(IPC.stopLoop) as Promise<void>,
  onRunOutput: (listener) => {
    const handler = (_event: IpcRendererEvent, chunk: { runId: string; text: string }) =>
      listener(chunk);
    ipcRenderer.on(IPC.runOutput, handler);
    return () => {
      ipcRenderer.removeListener(IPC.runOutput, handler);
    };
  }
};

contextBridge.exposeInMainWorld('bridge', api);
