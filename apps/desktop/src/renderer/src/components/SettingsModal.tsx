import React, { useState } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  port: number;
  token: string;
  onRegenerateToken: () => void;
}

export const SettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  port,
  token,
  onRegenerateToken
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const copyToken = () => {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <div
        style={{
          width: '480px',
          backgroundColor: 'var(--bg-secondary)',
          borderRadius: '8px',
          border: '1px solid var(--border-color)',
          padding: '24px',
          boxShadow: '0 10px 25px rgba(0, 0, 0, 0.5)'
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
          <h2 style={{ fontSize: '18px', fontWeight: 700 }}>Extension Pairing Settings</h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '18px',
              cursor: 'pointer'
            }}
          >
            ✕
          </button>
        </div>

        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
          Enter these connection details into the Bridge Chrome extension options page to pair securely.
        </p>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
            Local Port (127.0.0.1)
          </label>
          <input
            type="text"
            readOnly
            value={port}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border-color)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontFamily: 'monospace',
              fontSize: '13px'
            }}
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
            Pairing Secret Token
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="password"
              readOnly
              value={token}
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontFamily: 'monospace',
                fontSize: '13px'
              }}
            />
            <button
              type="button"
              onClick={copyToken}
              style={{
                padding: '8px 14px',
                backgroundColor: 'var(--accent-blue)',
                color: '#ffffff',
                border: 'none',
                fontSize: '12px',
                cursor: 'pointer'
              }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: '16px',
            borderTop: '1px solid var(--border-color)'
          }}
        >
          <button
            type="button"
            onClick={onRegenerateToken}
            style={{
              padding: '6px 12px',
              backgroundColor: 'transparent',
              color: 'var(--color-danger)',
              border: '1px solid var(--color-danger)',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            Regenerate Token
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 16px',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-color)',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
