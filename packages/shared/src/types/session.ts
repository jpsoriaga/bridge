export interface PairingCredentials {
  token: string;
  port: number;
  host: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WorkspaceStatus {
  selectedPath: string | null;
  isLocked: boolean;
  activeClientCount: number;
}
