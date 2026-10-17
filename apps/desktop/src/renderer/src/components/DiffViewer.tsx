import React from 'react';
import type { FileChange } from '@bridge/shared';

interface Props {
  stagedChanges: FileChange[];
  onApplyAll: () => void;
  onClear: () => void;
  isProcessing: boolean;
}

export const DiffViewer: React.FC<Props> = ({ stagedChanges, onApplyAll, onClear, isProcessing }) => {
  const getBadgeStyle = (action: string) => {
    switch (action) {
      case 'create':
        return { bg: 'rgba(34, 197, 94, 0.15)', text: '#4ade80', label: 'NEW' };
      case 'delete':
        return { bg: 'rgba(239, 68, 68, 0.15)', text: '#f87171', label: 'DEL' };
      case 'modify':
      default:
        return { bg: 'rgba(59, 130, 246, 0.15)', text: '#60a5fa', label: 'MOD' };
    }
  };

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border-color)',
        padding: '20px',
        marginBottom: '20px'
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px'
        }}
      >
        <div>
          <h2 style={{ fontSize: '15px', fontWeight: 600 }}>Incoming File Changes</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Review changes sent from paired Chrome extension before applying.
          </p>
        </div>

        {stagedChanges.length > 0 && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              disabled={isProcessing}
              onClick={onClear}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                backgroundColor: 'transparent',
                color: 'var(--text-muted)',
                border: '1px solid var(--border-color)',
                cursor: 'pointer'
              }}
            >
              Discard
            </button>
            <button
              type="button"
              disabled={isProcessing}
              onClick={onApplyAll}
              style={{
                padding: '6px 14px',
                fontSize: '12px',
                backgroundColor: 'var(--accent-blue)',
                color: '#ffffff',
                border: 'none',
                cursor: isProcessing ? 'wait' : 'pointer'
              }}
            >
              {isProcessing ? 'Applying...' : `Apply ${stagedChanges.length} Files`}
            </button>
          </div>
        )}
      </div>

      {stagedChanges.length === 0 ? (
        <div
          style={{
            padding: '36px',
            textAlign: 'center',
            border: '1px dashed var(--border-color)',
            borderRadius: '6px',
            color: 'var(--text-muted)',
            fontSize: '13px'
          }}
        >
          No pending changes. Blocks detected by the Bridge extension will appear here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {stagedChanges.map((change) => {
            const badge = getBadgeStyle(change.action);
            return (
              <div
                key={change.path}
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  backgroundColor: 'var(--bg-primary)',
                  overflow: 'hidden'
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border-color)',
                    backgroundColor: 'rgba(255, 255, 255, 0.02)'
                  }}
                >
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      padding: '2px 6px',
                      borderRadius: '4px',
                      backgroundColor: badge.bg,
                      color: badge.text
                    }}
                  >
                    {badge.label}
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--text-primary)' }}>
                    {change.path}
                  </span>
                </div>
                <pre
                  style={{
                    padding: '10px 12px',
                    margin: 0,
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    color: '#e2e8f0',
                    maxHeight: '140px',
                    overflowY: 'auto'
                  }}
                >
                  {change.content}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
