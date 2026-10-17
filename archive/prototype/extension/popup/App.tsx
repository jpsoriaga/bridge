import React, { useEffect, useState } from 'react';
import type { ConnectionState, ParsedFileChange } from '@bridge/shared';
import { ConnectionStatusBadge } from '../components/ConnectionStatusBadge';
import { FileChangeCard } from '../components/FileChangeCard';
import { bridgeClient } from '../services/bridge-client';
import { getSettings, type ExtensionSettings } from '../services/storage';

export const App: React.FC = () => {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('Initializing...');
  const [detectedChanges, setDetectedChanges] = useState<ParsedFileChange[]>([]);
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    setConnectionState('connecting');
    const s = await getSettings();
    setSettings(s);

    if (!s.token) {
      setConnectionState('disconnected');
      setStatusMessage('Pairing token missing. Please open Extension Options.');
      return;
    }

    const health = await bridgeClient.checkHealth();
    if (health.ok) {
      setConnectionState('connected');
      setStatusMessage(health.message);
    } else {
      setConnectionState('error');
      setStatusMessage(health.message);
    }
  };

  const handleApplyAll = async () => {
    if (detectedChanges.length === 0) return;
    setIsApplying(true);
    try {
      const result = await bridgeClient.applyChanges(
        detectedChanges.map((c) => ({
          path: c.path,
          action: c.action,
          content: c.content
        }))
      );
      setStatusMessage(`Successfully applied batch: ${result.batchId.slice(0, 8)}`);
      setDetectedChanges([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Error applying changes: ${msg}`);
    } finally {
      setIsApplying(false);
    }
  };

  const openOptions = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  };

  return (
    <div
      style={{
        width: '360px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        padding: '16px',
        backgroundColor: '#f9fafb',
        color: '#111827',
        boxSizing: 'border-box'
      }}
    >
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>Bridge</h1>
          <span
            style={{
              fontSize: '11px',
              backgroundColor: '#e5e7eb',
              padding: '2px 6px',
              borderRadius: '4px'
            }}
          >
            v0.1.0
          </span>
        </div>
        <ConnectionStatusBadge state={connectionState} port={settings?.port} />
      </header>

      <div
        style={{
          padding: '10px',
          borderRadius: '6px',
          backgroundColor: '#ffffff',
          border: '1px solid #e5e7eb',
          marginBottom: '12px',
          fontSize: '12px',
          color: '#374151'
        }}
      >
        <p style={{ margin: 0, lineHeight: 1.4 }}>{statusMessage}</p>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '8px'
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 600 }}>Detected Changes</span>
          <span style={{ fontSize: '12px', color: '#6b7280' }}>
            {detectedChanges.length} file{detectedChanges.length === 1 ? '' : 's'}
          </span>
        </div>

        {detectedChanges.length === 0 ? (
          <div
            style={{
              padding: '20px',
              textAlign: 'center',
              backgroundColor: '#ffffff',
              border: '1px dashed #d1d5db',
              borderRadius: '6px',
              fontSize: '12px',
              color: '#9ca3af'
            }}
          >
            No @@FILE blocks detected on current page yet.
          </div>
        ) : (
          <div>
            {detectedChanges.map((change) => (
              <FileChangeCard key={change.path} change={change} />
            ))}
            <button
              type="button"
              disabled={isApplying || connectionState !== 'connected'}
              onClick={handleApplyAll}
              style={{
                width: '100%',
                marginTop: '8px',
                padding: '8px',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {isApplying ? 'Applying...' : `Apply All (${detectedChanges.length})`}
            </button>
          </div>
        )}
      </div>

      <footer
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: '8px',
          borderTop: '1px solid #e5e7eb'
        }}
      >
        <button
          type="button"
          onClick={checkStatus}
          style={{
            fontSize: '11px',
            color: '#4b5563',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0
          }}
        >
          ↻ Refresh
        </button>
        <button
          type="button"
          onClick={openOptions}
          style={{
            fontSize: '11px',
            color: '#2563eb',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0
          }}
        >
          Pairing Settings ⚙
        </button>
      </footer>
    </div>
  );
};
