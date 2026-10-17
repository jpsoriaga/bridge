import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

const icons = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png'
};

/**
 * Public half of the extension key. It pins the unpacked extension's ID to
 * BRIDGE_EXTENSION_ID in @bridge/shared, which the desktop allowlists by Origin.
 * The private half isn't needed for "Load unpacked" and isn't kept.
 */
export const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsXErLlD2rKBa0Ivi+XfBA0N+L7ePFgRFsk6DZDIlGhVfhRcaimYV1nuhMGLqeHk4wEFrqdfBSDb+uLBVyje64qpJMOj9ydStkfh327Xq3sUgZbrf6Bjear1uRsCudSldPPp2dxs2zPk+663HcA0OWMpOH6WT1phC9gD6cTrQk9/Q+lHKwX7zEYwUaUAEg4lnOXZ+Jpr2vArZ3+xI355I2TamOeEAq9/rGD6Cub8OQjv+lzIvQz+myP77fZUY7T/7cN2+0aKlDmmsFCcSf2e79pXCxa9VbCglcLCMvZlCT+Vh5ZA/OtQQPiWe8MT1i8mAjxLWQIVMPivgCNEc2cfNIQIDAQAB';

export default defineManifest({
  manifest_version: 3,
  name: 'Bridge',
  version: pkg.version,
  description: 'Apply file edits from your chat to a local project through the Bridge desktop app.',
  key: EXTENSION_PUBLIC_KEY,
  icons,
  // Only what is used today. The content script match below is the extension's only
  // access to any website.
  permissions: ['storage', 'sidePanel'],
  // Loopback only, for the service worker's fetch to the desktop's /health, /pair and
  // /unpair. The desktop sends no CORS headers, so without this the worker can't read
  // the responses. The WebSocket itself doesn't need it. See PLAN.md.
  host_permissions: ['http://127.0.0.1/*'],
  action: {
    default_title: 'Open Bridge',
    default_icon: icons
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html'
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module'
  },
  content_scripts: [
    {
      matches: ['https://chatgpt.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle'
    }
  ]
});
