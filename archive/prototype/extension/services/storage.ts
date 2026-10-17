export interface ExtensionSettings {
  port: number;
  token: string;
  autoSync: boolean;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  port: 49152,
  token: '',
  autoSync: false
};

export async function getSettings(): Promise<ExtensionSettings> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return DEFAULT_SETTINGS;
  }
  const result = await chrome.storage.local.get(['port', 'token', 'autoSync']);
  return {
    port: typeof result.port === 'number' ? result.port : DEFAULT_SETTINGS.port,
    token: typeof result.token === 'string' ? result.token : DEFAULT_SETTINGS.token,
    autoSync: typeof result.autoSync === 'boolean' ? result.autoSync : DEFAULT_SETTINGS.autoSync
  };
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return;
  }
  await chrome.storage.local.set(settings);
}
