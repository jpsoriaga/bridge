import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

const icons = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
  128: 'icons/icon-128.png'
};

export default defineManifest({
  manifest_version: 3,
  name: 'Bridge',
  version: pkg.version,
  description: 'Apply file edits from your chat to a local project through the Bridge desktop app.',
  icons,
  // Only what is used today. No host_permissions: the content script match below is
  // the extension's only access to any site.
  permissions: ['storage', 'sidePanel'],
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
