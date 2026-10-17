import type { BridgeApi } from './api';

declare global {
  interface Window {
    bridge: BridgeApi;
  }
}

export {};
