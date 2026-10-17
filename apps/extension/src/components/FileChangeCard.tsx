import React from 'react';
import type { ParsedFileChange } from '@bridge/shared';
import { truncatePath } from '../lib/utils';

interface Props {
  change: ParsedFileChange;
  onApply?: (change: ParsedFileChange) => void;
  disabled?: boolean;
}

export const FileChangeCard: React.FC<Props> = ({ change, onApply, disabled }) => {
  const getActionColor = (action: string) => {
    switch (action) {
      case 'create':
        return '#16a34a';
      case 'delete':
        return '#dc2626';
      case 'modify':
      default:
        return '#2563eb';
    }
  };

  const lineCount = change.content.split('\n').length;

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: '6px',
        padding: '10px 12px',
        marginBottom: '8px',
        backgroundColor: '#ffffff'
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '4px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              fontSize: '10px',
              textTransform: 'uppercase',
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: '4px',
              color: '#ffffff',
              backgroundColor: getActionColor(change.action)
            }}
          >
            {change.action}
          </span>
          <span
            style={{
              fontFamily: 'monospace',
              fontSize: '12px',
              fontWeight: 600,
              color: '#1f2937'
            }}
            title={change.path}
          >
            {truncatePath(change.path)}
          </span>
        </div>
        <span style={{ fontSize: '11px', color: '#6b7280' }}>
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </span>
      </div>

      {onApply && (
        <div style={{ marginTop: '8px', textAlign: 'right' }}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onApply(change)}
            style={{
              fontSize: '11px',
              padding: '4px 10px',
              backgroundColor: disabled ? '#9ca3af' : '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              cursor: disabled ? 'not-allowed' : 'pointer'
            }}
          >
            Apply File
          </button>
        </div>
      )}
    </div>
  );
};
