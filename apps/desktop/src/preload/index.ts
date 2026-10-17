import { contextBridge } from 'electron';
import type { BridgeApi } from './api';

declare const __BRIDGE_VERSION__: string;

const api: BridgeApi = {
  version: __BRIDGE_VERSION__
};

contextBridge.exposeInMainWorld('bridge', api);
