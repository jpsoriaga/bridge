// Help → Copy diagnostics: what a bug report needs about this app, as text for the
// clipboard. Built only from versions, states and the log (no file contents, no keys or
// tokens), then run through the shared redaction with the home folder shortened.

import {
  buildDiagnostics,
  PROTOCOL_VERSION,
  type ConnectionStatus,
  type Mode,
  type UpdateChannel
} from '@bridge/shared';

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
};

export interface AppDiagnostics {
  version: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  /** `process.getSystemVersion()`: 15.1.0 on macOS, 10.0.22631 on Windows. */
  osVersion: string;
  /** From the extension's last socket (`BridgeServer.browser`), or null. */
  browser: string | null;
  status: ConnectionStatus;
  paired: boolean;
  port: number | null;
  mode: Mode;
  /** The open project's path, or null. Shown with `~`. */
  project: string | null;
  updateChannel: UpdateChannel;
  log: readonly string[];
  home: string;
  time: Date;
}

export function appDiagnostics(d: AppDiagnostics): string {
  return buildDiagnostics({
    source: 'app',
    fields: [
      ['App', `${d.version}${d.packaged ? '' : ' (development build)'}`],
      // The app never hears the extension's version; its own diagnostics have it.
      ['Extension', 'see the side panel’s Copy diagnostics'],
      ['Protocol', PROTOCOL_VERSION],
      ['OS', `${OS_NAMES[d.platform] ?? d.platform} ${d.osVersion} (${d.arch})`],
      ['Browser', d.browser ?? 'not connected yet'],
      ['Mode', d.mode],
      ['Connection', d.status],
      ['Paired', d.paired ? 'yes' : 'no'],
      ['Server', d.port === null ? 'not running' : `127.0.0.1:${d.port}`],
      ['Project', d.project ?? 'none open'],
      ['Update channel', d.updateChannel]
    ],
    log: d.log,
    home: d.home,
    time: d.time.toISOString()
  });
}
