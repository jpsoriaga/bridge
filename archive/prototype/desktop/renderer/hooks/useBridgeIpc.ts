import { useCallback, useEffect, useState } from 'react';

export function useBridgeIpc() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [pairingInfo, setPairingInfo] = useState<{ port: number; token: string } | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.bridgeApi) {
      setIsReady(true);
      window.bridgeApi.getWorkspace().then((res) => setWorkspace(res.workspace));
      window.bridgeApi.getPairingInfo().then((res) => setPairingInfo(res));
    }
  }, []);

  const selectWorkspace = useCallback(async () => {
    if (!window.bridgeApi) return;
    const res = await window.bridgeApi.selectWorkspace();
    if (!res.canceled && res.path) {
      setWorkspace(res.path);
    }
  }, []);

  const undoLast = useCallback(async () => {
    if (!window.bridgeApi) return { success: false, revertedFiles: [] };
    return await window.bridgeApi.undoLast();
  }, []);

  const regenerateToken = useCallback(async () => {
    if (!window.bridgeApi) return;
    const res = await window.bridgeApi.regeneratePairingToken();
    setPairingInfo(res);
  }, []);

  const runCommand = useCallback(async (executable: string, args: string[]) => {
    if (!window.bridgeApi) {
      return { success: false, stdout: '', stderr: '', error: 'IPC bridge not available' };
    }
    return await window.bridgeApi.runCommand(executable, args);
  }, []);

  return {
    isReady,
    workspace,
    pairingInfo,
    selectWorkspace,
    undoLast,
    regenerateToken,
    runCommand
  };
}
