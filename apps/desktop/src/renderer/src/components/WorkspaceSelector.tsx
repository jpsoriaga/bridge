import React from 'react';

interface Props {
  workspace: string | null;
  onSelect: () => void;
}

export const WorkspaceSelector: React.FC<Props> = ({ workspace, onSelect }) => {
  return (
    <div
      style={{
        padding: '16px 20px',
        backgroundColor: 'var(--bg-secondary)',
        borderRadius: '8px',
        border: '1px solid var(--border-color)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}
    >
      <div>
        <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '4px' }}>
          Active Workspace Directory
        </div>
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '13px',
            color: workspace ? 'var(--text-primary)' : 'var(--color-warning)',
            fontWeight: 500
          }}
        >
          {workspace || 'No workspace selected. Select a folder to enable file operations.'}
        </div>
        {workspace && (
          <div style={{ fontSize: '11px', color: 'var(--color-success)', marginTop: '4px' }}>
            🔒 Strict path traversal protection & symlink confinement active
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSelect}
        style={{
          padding: '8px 16px',
          fontSize: '13px',
          backgroundColor: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color)',
          cursor: 'pointer'
        }}
      >
        {workspace ? 'Change Folder' : 'Select Folder'}
      </button>
    </div>
  );
};
