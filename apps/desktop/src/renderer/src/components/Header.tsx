import React from 'react';

interface Props {
  onOpenSettings: () => void;
  onUndo: () => void;
  canUndo: boolean;
  port?: number;
}

export const Header: React.FC<Props> = ({ onOpenSettings, onUndo, canUndo, port }) => {
  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '16px 24px',
        backgroundColor: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-color)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <h1 style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '-0.02em' }}>Bridge</h1>
        <span
          style={{
            fontSize: '11px',
            backgroundColor: 'rgba(59, 130, 246, 0.2)',
            color: '#60a5fa',
            padding: '2px 8px',
            borderRadius: '9999px',
            fontWeight: 600
          }}
        >
          v0.1.0
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: '#4ade80',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            padding: '3px 8px',
            borderRadius: '4px'
          }}
        >
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22c55e' }} />
          Local Server: 127.0.0.1:{port || '49152'}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <button
          type="button"
          disabled={!canUndo}
          onClick={onUndo}
          style={{
            padding: '6px 12px',
            fontSize: '12px',
            backgroundColor: canUndo ? 'var(--bg-primary)' : 'rgba(255,255,255,0.05)',
            color: canUndo ? 'var(--text-primary)' : 'var(--text-muted)',
            border: '1px solid var(--border-color)',
            cursor: canUndo ? 'pointer' : 'not-allowed'
          }}
        >
          ↶ Undo Last Sync
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          style={{
            padding: '6px 12px',
            fontSize: '12px',
            backgroundColor: 'var(--accent-blue)',
            color: '#ffffff',
            border: 'none',
            cursor: 'pointer'
          }}
        >
          Pairing Settings ⚙
        </button>
      </div>
    </header>
  );
};
