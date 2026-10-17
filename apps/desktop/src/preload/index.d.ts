import type { BridgeElectronApi } from './index';

declare global {
  interface Window {
    bridgeApi: BridgeElectronApi;
  }
}

export {};
