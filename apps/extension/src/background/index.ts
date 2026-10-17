import { bridgeClient } from '../services/bridge-client';
import { getSettings } from '../services/storage';

console.log('[Bridge Extension] Background service worker initialized');

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`[Bridge Extension] Installed (reason: ${details.reason})`);
  const settings = await getSettings();
  if (!settings.token) {
    chrome.runtime.openOptionsPage();
  }
});

// Listener for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CHECK_HEALTH') {
    bridgeClient.checkHealth().then((res) => sendResponse(res));
    return true; // Keep channel open for async response
  }

  if (message.type === 'APPLY_CHANGES') {
    bridgeClient
      .applyChanges(message.changes)
      .then((res) => sendResponse({ success: true, data: res }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  return false;
});
