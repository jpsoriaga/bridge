import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../preload/api';
import { guardIpc, IPC_ARGS, type IpcChannel } from './ipc';

const EVENTS = new Set(['status', 'activity', 'runOutput', 'menu']);
const channels = (Object.keys(IPC) as (keyof typeof IPC)[]).filter(
  (key): key is IpcChannel => !EVENTS.has(key)
);

/** One good call per channel, and calls of the wrong shape. */
const CALLS: Record<IpcChannel, { good: unknown[]; bad: unknown[][] }> = {
  getStatus: { good: [], bad: [[1]] },
  startPairing: { good: [], bad: [['x']] },
  confirmPairing: { good: [], bad: [[true]] },
  cancelPairing: { good: [], bad: [[{}]] },
  unpair: { good: [], bad: [[null]] },
  openFolder: { good: [], bad: [['/etc']] },
  openRecent: { good: [0], bad: [[], ['0'], [-1], [1.5], ['/etc']] },
  getActivity: { good: [], bad: [[1]] },
  undo: { good: ['op-1'], bad: [[], [1], ['x'.repeat(200)]] },
  undoLast: { good: [], bad: [['x']] },
  setDenyPatterns: { good: [['*.log']], bad: [[], ['*.log'], [[1]], [Array(1001).fill('a')]] },
  setMode: { good: ['auto-apply'], bad: [['root'], [], [1]] },
  setAllowlist: { good: [['pnpm test *']], bad: [['pnpm test'], [{ 0: 'x' }]] },
  setBackgroundEntries: { good: [['npm run dev']], bad: [['npm run dev'], [[1]]] },
  setAutoApprove: {
    good: [{ changes: true, gated: false, partial: false }],
    bad: [[{ changes: true }], [{ changes: 1, gated: false, partial: false }], [true]]
  },
  dismissUnlimitedNote: { good: [], bad: [[true]] },
  stopProcess: { good: ['proc-1'], bad: [[], [1]] },
  getProcessLogs: { good: ['proc-1'], bad: [[{}]] },
  openProcessUrl: { good: ['proc-1'], bad: [['http://localhost:5173', 'x'], [1]] },
  setGatedPatterns: { good: [[]], bad: [[null]] },
  setEnvPatterns: { good: [['MY_*']], bad: [['MY_*']] },
  setRunSettings: {
    good: [
      {
        timeoutMs: 60_000,
        installTimeoutMs: 300_000,
        stepLimit: 5,
        pauseOnFailure: true,
        catchUpAfterSleep: true
      }
    ],
    bad: [
      [{ timeoutMs: 1 }],
      [{ timeoutMs: 1, stepLimit: 1, pauseOnFailure: false, extra: 1 }],
      ['x']
    ]
  },
  setPathOverride: { good: ['/usr/bin:/bin'], bad: [[1], [['/usr/bin']]] },
  cancelRun: { good: [], bad: [['run-1']] },
  stopLoop: { good: [], bad: [[1]] },
  getOpDetail: { good: ['op-1'], bad: [[{}]] },
  getRunDetail: { good: ['run-1'], bad: [[1]] },
  setTheme: { good: ['dark'], bad: [['neon'], []] },
  setUiGuidance: { good: ['always'], bad: [['sometimes'], [true]] },
  setBackupRetention: { good: [7], bad: [['7'], [7.5]] },
  openBackupsFolder: { good: [], bad: [['/']] },
  clearBackups: { good: [], bad: [[true]] },
  setOnboardingDismissed: { good: [true], bad: [['true'], []] },
  dismissAllowlistNote: { good: [], bad: [[1]] },
  answerInstallNote: { good: [true], bad: [[], ['yes']] },
  checkForUpdates: { good: [], bad: [['https://example.com']] },
  setCheckUpdatesOnStart: { good: [false], bad: [['yes'], []] },
  setUpdateChannel: { good: ['beta'], bad: [['nightly'], [], ['stable', 'beta']] },
  copyDiagnostics: { good: [], bad: [['all']] },
  openLogsFolder: { good: [], bad: [['/etc']] }
};

const window = { sender: { id: 1 }, frame: { id: 'top' } };
const own = { sender: window.sender, senderFrame: window.frame };

describe('IPC', () => {
  it('has a schema for every channel the renderer invokes, and nothing else', () => {
    expect(Object.keys(IPC_ARGS).sort()).toEqual([...channels].sort());
    expect(Object.keys(CALLS).sort()).toEqual([...channels].sort());
  });

  it('registers every channel in main through the guard, never ipcMain.handle directly', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    for (const channel of channels) expect(source).toContain(`handle(IPC.${channel},`);
    expect(source.match(/ipcMain\.handle\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/ipcMain\.on\(/);
  });

  it.each(channels)(
    '%s takes only its own window’s top frame and arguments of its shape',
    (channel) => {
      const fn = vi.fn(() => 'ok');
      const handler = guardIpc(channel, () => window, fn);
      expect(handler(own, ...CALLS[channel].good)).toBe('ok');
      for (const args of CALLS[channel].bad) {
        expect(() => handler(own, ...args), JSON.stringify(args)).toThrow('Invalid arguments');
      }
      expect(() =>
        handler({ sender: { id: 2 }, senderFrame: window.frame }, ...CALLS[channel].good)
      ).toThrow('Unknown sender');
      expect(() =>
        handler({ sender: window.sender, senderFrame: { id: 'iframe' } }, ...CALLS[channel].good)
      ).toThrow('Unknown frame');
      expect(() => guardIpc(channel, () => null, fn)(own, ...CALLS[channel].good)).toThrow(
        'Unknown sender'
      );
      // Only the good call ever reached the handler.
      expect(fn).toHaveBeenCalledTimes(1);
    }
  );
});
