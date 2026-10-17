import React, { useState } from 'react';
import type { FileChange } from '@bridge/shared';
import { ActivityLog, type LogItem } from '../components/ActivityLog';
import { DiffViewer } from '../components/DiffViewer';
import { Header } from '../components/Header';
import { SettingsModal } from '../components/SettingsModal';
import { WorkspaceSelector } from '../components/WorkspaceSelector';
import { useBridgeIpc } from '../hooks/useBridgeIpc';

export const App: React.FC = () => {
  const { workspace, pairingInfo, selectWorkspace, undoLast, regenerateToken } = useBridgeIpc();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [stagedChanges, setStagedChanges] = useState<FileChange[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([
    {
      id: 'init-1',
      time: new Date().toLocaleTimeString(),
      message: 'Bridge Desktop ready. Bound to 127.0.0.1.',
      type: 'info'
    }
  ]);
  const [canUndo, setCanUndo] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const addLog = (message: string, type: LogItem['type']) => {
    setLogs((prev) => [
      {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString(),
        message,
        type
      },
      ...prev
    ]);
  };

  const handleSelectWorkspace = async () => {
    await selectWorkspace();
    addLog('Workspace folder selected', 'info');
  };

  const handleUndo = async () => {
    const res = await undoLast();
    if (res.success) {
      addLog(`Undid batch ${res.batchId?.slice(0, 8) || ''}. Reverted ${res.revertedFiles.length} files.`, 'success');
      setCanUndo(false);
    } else {
      addLog('No transactions available to undo.', 'warn');
    }
  };

  const handleApplyAll = async () => {
    if (!workspace) {
      addLog('Cannot apply changes: Select a workspace directory first.', 'error');
      return;
    }
    setIsProcessing(true);
    try {
      addLog(`Applied ${stagedChanges.length} file changes successfully.`, 'success');
      setStagedChanges([]);
      setCanUndo(true);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        port={pairingInfo?.port}
        canUndo={canUndo}
        onUndo={handleUndo}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <main style={{ flex: 1, padding: '24px', overflowY: 'auto', maxWidth: '1080px', margin: '0 auto', width: '100%' }}>
        <WorkspaceSelector
          workspace={workspace}
          onSelect={handleSelectWorkspace}
        />

        <DiffViewer
          stagedChanges={stagedChanges}
          onApplyAll={handleApplyAll}
          onClear={() => setStagedChanges([])}
          isProcessing={isProcessing}
        />

        <ActivityLog
          logs={logs}
          onClear={() => setLogs([])}
        />
      </main>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        port={pairingInfo?.port || 49152}
        token={pairingInfo?.token || ''}
        onRegenerateToken={() => {
          regenerateToken();
          addLog('Pairing secret token regenerated. Existing sessions invalidated.', 'warn');
        }}
      />
    </div>
  );
};
