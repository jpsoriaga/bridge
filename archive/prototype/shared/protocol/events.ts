export const MessageType = {
  // Handshake & Authentication
  HANDSHAKE_REQUEST: 'bridge:handshake_request',
  HANDSHAKE_RESPONSE: 'bridge:handshake_response',

  // Health & Heartbeat
  PING: 'bridge:ping',
  PONG: 'bridge:pong',

  // Workspace & Status
  GET_STATUS_REQUEST: 'bridge:get_status_request',
  GET_STATUS_RESPONSE: 'bridge:get_status_response',

  // File Operations
  APPLY_CHANGES_REQUEST: 'bridge:apply_changes_request',
  APPLY_CHANGES_RESPONSE: 'bridge:apply_changes_response',

  // Error Envelope
  ERROR_RESPONSE: 'bridge:error_response'
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];
