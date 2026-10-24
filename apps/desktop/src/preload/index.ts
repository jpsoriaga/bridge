import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type ActivityEntry,
  type AutoApproveSettings,
  type BridgeApi,
  type DesktopState,
  type MenuAction,
  type OpDetail,
  type OpenFolderResult,
  type PairingCode,
  type RunDetail,
  type SaveListResult,
  type UndoOutcome,
  type UpdateCheck
} from './api';
import type { BackgroundLogs, Mode } from '@bridge/shared';

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
  confirmPairing: () => ipcRenderer.invoke(IPC.confirmPairing) as Promise<boolean>,
  cancelPairing: () => ipcRenderer.invoke(IPC.cancelPairing) as Promise<void>,
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
  setBackgroundEntries: (entries) =>
    ipcRenderer.invoke(IPC.setBackgroundEntries, entries) as Promise<SaveListResult>,
  setAutoApprove: (settings) =>
    ipcRenderer.invoke(IPC.setAutoApprove, settings) as Promise<AutoApproveSettings>,
  dismissUnlimitedNote: () => ipcRenderer.invoke(IPC.dismissUnlimitedNote) as Promise<void>,
  stopProcess: (procId) => ipcRenderer.invoke(IPC.stopProcess, procId) as Promise<boolean>,
  getProcessLogs: (procId) =>
    ipcRenderer.invoke(IPC.getProcessLogs, procId) as Promise<BackgroundLogs | null>,
  openProcessUrl: (procId) => ipcRenderer.invoke(IPC.openProcessUrl, procId) as Promise<boolean>,
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
  },
  getOpDetail: (opId) => ipcRenderer.invoke(IPC.getOpDetail, opId) as Promise<OpDetail | null>,
  getRunDetail: (runId) => ipcRenderer.invoke(IPC.getRunDetail, runId) as Promise<RunDetail | null>,
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme) as Promise<boolean>,
  setBackupRetention: (days) =>
    ipcRenderer.invoke(IPC.setBackupRetention, days) as Promise<boolean>,
  openBackupsFolder: () => ipcRenderer.invoke(IPC.openBackupsFolder) as Promise<boolean>,
  clearBackups: () => ipcRenderer.invoke(IPC.clearBackups) as Promise<boolean>,
  setOnboardingDismissed: (dismissed) =>
    ipcRenderer.invoke(IPC.setOnboardingDismissed, dismissed) as Promise<void>,
  dismissAllowlistNote: () => ipcRenderer.invoke(IPC.dismissAllowlistNote) as Promise<void>,
  answerInstallNote: (add) => ipcRenderer.invoke(IPC.answerInstallNote, add) as Promise<void>,
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates) as Promise<UpdateCheck>,
  setCheckUpdatesOnStart: (on) =>
    ipcRenderer.invoke(IPC.setCheckUpdatesOnStart, on) as Promise<void>,
  setUpdateChannel: (channel) => ipcRenderer.invoke(IPC.setUpdateChannel, channel) as Promise<void>,
  copyDiagnostics: () => ipcRenderer.invoke(IPC.copyDiagnostics) as Promise<boolean>,
  openLogsFolder: () => ipcRenderer.invoke(IPC.openLogsFolder) as Promise<boolean>,
  onMenu: (listener) => {
    const handler = (_event: IpcRendererEvent, action: MenuAction) => listener(action);
    ipcRenderer.on(IPC.menu, handler);
    return () => {
      ipcRenderer.removeListener(IPC.menu, handler);
    };
  }
};

contextBridge.exposeInMainWorld('bridge', api);
