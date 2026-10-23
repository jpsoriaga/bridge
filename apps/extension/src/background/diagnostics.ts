// The side panel's Copy diagnostics: versions, the browser and system, the app's mode, the
// connection, the chat tab next to the panel, and the worker's recent events. No file
// contents, keys or tokens; the shared builder redacts the whole block anyway.

import {
  buildDiagnostics,
  DIAGNOSTICS_LOG_LINES,
  PROTOCOL_VERSION,
  type ConnectionStatus,
  type Mode
} from '@bridge/shared';

export interface ExtensionDiagnostics {
  /** `version_name` (a beta's full version) or `version` from the manifest. */
  version: string;
  /** From the app's /health or status, or null if none answered. */
  appVersion: string | null;
  /** `Chrome 141.0.7390.54`, or null. */
  browser: string | null;
  /** chrome.runtime.getPlatformInfo(): `mac`, `win`, `linux`…, and `arm64`, `x86-64`… */
  os: string | null;
  arch: string | null;
  status: ConnectionStatus;
  mode: Mode | null;
  /** The project as the app shows it (already `~/…`), or null. */
  project: string | null;
  /** The chat tab next to the panel, in a few words. */
  chatTab: string;
  log: readonly string[];
  time: Date;
}

const OS_NAMES: Record<string, string> = {
  mac: 'macOS',
  win: 'Windows',
  linux: 'Linux',
  cros: 'ChromeOS'
};

export function extensionDiagnostics(d: ExtensionDiagnostics): string {
  return buildDiagnostics({
    source: 'extension',
    fields: [
      ['Extension', d.version],
      ['App', d.appVersion ?? 'not reached'],
      ['Protocol', PROTOCOL_VERSION],
      ['OS', d.os && `${OS_NAMES[d.os] ?? d.os} (${d.arch ?? 'unknown'})`],
      ['Browser', d.browser],
      ['Mode', d.mode ?? 'unknown (not connected)'],
      ['Connection', d.status],
      ['Project', d.project ?? 'none open'],
      ['Chat tab', d.chatTab]
    ],
    log: d.log.slice(-DIAGNOSTICS_LOG_LINES),
    time: d.time.toISOString()
  });
}

/** What `navigator.userAgentData.getHighEntropyValues` returns that Bridge reads. */
interface HighEntropy {
  fullVersionList?: { brand: string; version: string }[];
}

/**
 * The browser's name and full version: from User-Agent Client Hints when Chrome has them
 * (they name Edge, Brave and Opera, with the full version), else from the User-Agent.
 */
export async function browserVersion(
  nav: { userAgent: string; userAgentData?: unknown },
  fromUserAgent: (ua: string) => string | null
): Promise<string | null> {
  const data = nav.userAgentData as
    { getHighEntropyValues?: (hints: string[]) => Promise<HighEntropy> } | undefined;
  try {
    const values = await data?.getHighEntropyValues?.(['fullVersionList']);
    const brands = values?.fullVersionList ?? [];
    const named = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand));
    const brand = named ?? brands.find((b) => /chromium/i.test(b.brand));
    if (brand) return `${brand.brand} ${brand.version}`;
  } catch {
    // Not offered: fall back to the User-Agent string.
  }
  return fromUserAgent(nav.userAgent);
}
