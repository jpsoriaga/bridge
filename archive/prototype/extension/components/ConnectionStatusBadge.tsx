import React from 'react';
import type { ConnectionState } from '@bridge/shared';

interface Props {
  state: ConnectionState;
  port?: number;
}

export const ConnectionStatusBadge: React.FC<Props> = ({ state, port }) => {
  const getBadgeStyle = (): { bg: string; text: string; dot: string } => {
    switch (state) {
      case 'connected':
        return { bg: '#dcfce7', text: '#15803d', dot: '#22c55e' };
      case 'connecting':
        return { bg: '#fef3c7', text: '#b45309', dot: '#f59e0b' };
      case 'error':
        return { bg: '#fee2e2', text: '#b91c1c', dot: '#ef4444' };
      case 'disconnected':
      default:
        return { bg: '#f3f4f6', text: '#4b5563', dot: '#9ca3af' };
    }
  };

  const style = getBadgeStyle();

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: '9999px',
        backgroundColor: style.bg,
        color: style.text,
        fontSize: '12px',
        fontWeight: 500
      }}
    >
      <span
        style={{
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          backgroundColor: style.dot
        }}
      />
      <span>
        {state === 'connected' ? `Connected (Port ${port ?? '?'})` : state.toUpperCase()}
      </span>
    </div>
  );
};
