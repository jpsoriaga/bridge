import React from 'react';

export interface LogItem {
  id: string;
  time: string;
  message: string;
  type: 'info' | 'success' | 'warn' | 'error';
}

interface Props {
  logs: LogItem[];
  onClear: () => void;
}

export const ActivityLog: React.FC<Props> = ({ logs, onClear }) => {
  const getTypeColor = (type: string) => {
    switch (type) {
      case 'success':
        return 'var(--color-success)';
      case 'warn':
        return 'var(--color-warning)';
      case 'error':
        return 'var(--color-danger)';
      case 'info':
      default:
        return 'var(--accent-blue)';
    }
  };

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border-color)',
        padding: '20px'
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px'
        }}
      >
        <h2 style={{ fontSize: '15px', fontWeight: 600 }}>Activity & Audit Log</h2>
        {logs.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            style={{
              padding: '4px 8px',
              fontSize: '11px',
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Clear Log
          </button>
        )}
      </div>

      <div
        style={{
          maxHeight: '160px',
          overflowY: 'auto',
          backgroundColor: 'var(--bg-primary)',
          border: '1px solid var(--border-color)',
          borderRadius: '6px',
          padding: '8px 12px',
          fontFamily: 'monospace',
          fontSize: '12px'
        }}
      >
        {logs.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '12px' }}>
            No recent activity recorded.
          </div>
        ) : (
          logs.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                gap: '8px',
                padding: '4px 0',
                borderBottom: '1px solid rgba(255, 255, 255, 0.04)'
              }}
            >
              <span style={{ color: 'var(--text-muted)' }}>[{item.time}]</span>
              <span style={{ color: getTypeColor(item.type), fontWeight: 600 }}>
                {item.type.toUpperCase()}
              </span>
              <span style={{ color: 'var(--text-primary)' }}>{item.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
