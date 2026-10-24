import { z } from 'zod';
import { MODES, UI_GUIDANCE, UPDATE_CHANNELS } from '@bridge/shared';
import { IPC } from '../preload/api';

// The renderer is treated as untrusted: every `window.bridge` call reaches main through
// one of these channels, and main checks who sent it and the shape of its arguments before
// the handler sees them. Handlers still check meaning (a valid pattern, a known project).

const text = (max = 4096) => z.string().max(max);
const list = z.array(text(1024)).max(1000);
const none = z.tuple([]);

/** The arguments each channel accepts, as a tuple. Nothing else gets through. */
export const IPC_ARGS: Readonly<Record<IpcChannel, z.ZodType<unknown[]>>> = {
  getStatus: none,
  startPairing: none,
  confirmPairing: none,
  cancelPairing: none,
  unpair: none,
  openFolder: none,
  openRecent: z.tuple([z.number().int().min(0).max(100)]),
  getActivity: none,
  undo: z.tuple([text(128)]),
  undoLast: none,
  setDenyPatterns: z.tuple([list]),
  setMode: z.tuple([z.enum(MODES)]),
  setAllowlist: z.tuple([list]),
  setBackgroundEntries: z.tuple([list]),
  setAutoApprove: z.tuple([
    z.strictObject({ changes: z.boolean(), gated: z.boolean(), partial: z.boolean() })
  ]),
  dismissUnlimitedNote: none,
  stopProcess: z.tuple([text(128)]),
  getProcessLogs: z.tuple([text(128)]),
  openProcessUrl: z.tuple([text(128)]),
  setGatedPatterns: z.tuple([list]),
  setEnvPatterns: z.tuple([list]),
  setRunSettings: z.tuple([
    z.strictObject({
      timeoutMs: z.number(),
      installTimeoutMs: z.number(),
      stepLimit: z.number().nullable(),
      pauseOnFailure: z.boolean(),
      catchUpAfterSleep: z.boolean()
    })
  ]),
  setPathOverride: z.tuple([text(32_768)]),
  cancelRun: none,
  stopLoop: none,
  getOpDetail: z.tuple([text(128)]),
  getRunDetail: z.tuple([text(128)]),
  setTheme: z.tuple([z.enum(['system', 'light', 'dark'])]),
  setUiGuidance: z.tuple([z.enum(UI_GUIDANCE)]),
  setBackupRetention: z.tuple([z.number().int()]),
  openBackupsFolder: none,
  clearBackups: none,
  setOnboardingDismissed: z.tuple([z.boolean()]),
  dismissAllowlistNote: none,
  answerInstallNote: z.tuple([z.boolean()]),
  answerBackgroundNote: z.tuple([z.boolean()]),
  checkForUpdates: none,
  setCheckUpdatesOnStart: z.tuple([z.boolean()]),
  setUpdateChannel: z.tuple([z.enum(UPDATE_CHANNELS)]),
  copyDiagnostics: none,
  openLogsFolder: none
};

/** Channels the renderer invokes. The rest of `IPC` are main → renderer events. */
export type IpcChannel = Exclude<keyof typeof IPC, 'status' | 'activity' | 'runOutput' | 'menu'>;

/** What a handler needs to know about the call: the frame it came from. */
export interface IpcEventLike {
  sender: unknown;
  senderFrame: unknown;
}

/**
 * Wraps a handler so it runs only for the app's own window's top frame, and only with
 * arguments of the right shape. Anything else throws, and the renderer's promise rejects.
 */
export function guardIpc<T>(
  channel: IpcChannel,
  ownFrame: () => { sender: unknown; frame: unknown } | null,
  fn: (...args: unknown[]) => T
): (event: IpcEventLike, ...args: unknown[]) => T {
  const schema = IPC_ARGS[channel];
  return (event, ...args) => {
    const own = ownFrame();
    if (!own || event.sender !== own.sender) throw new Error('Unknown sender');
    if (event.senderFrame !== own.frame) throw new Error('Unknown frame');
    const parsed = schema.safeParse(args);
    if (!parsed.success) throw new Error(`Invalid arguments for ${channel}`);
    return fn(...parsed.data);
  };
}
