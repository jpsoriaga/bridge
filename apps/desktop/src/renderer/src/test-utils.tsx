import { vi } from 'vitest';
import type {
  ActivityEntry,
  BridgeApi,
  DesktopState,
  MenuAction,
  OpDetail
} from '../../preload/api';

/** A desktop state with everything set up, for tests to override. */
export function makeState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    status: 'connected',
    paired: true,
    port: 47821,
    pairing: null,
    lockedUntil: null,
    project: { name: 'app', path: '~/code/app' },
    recentProjects: [
      { name: 'app', path: '~/code/app' },
      { name: 'site', path: '~/code/site' }
    ],
    defaultDenyPatterns: ['.git/', '.env'],
    denyPatterns: [],
    mode: 'manual',
    allowlist: ['pnpm test'],
    allowlistSuggestions: [],
    sessionResets: 0,
    allowlistNote: false,
    defaultGatedPatterns: ['package.json'],
    gatedPatterns: [],
    defaultEnvPatterns: ['*TOKEN*'],
    envPatterns: [],
    runSettings: { timeoutMs: 120_000, stepLimit: 10, pauseOnFailure: false },
    commandPath: { source: 'login-shell', path: '/usr/bin:/bin', override: '' },
    running: null,
    loop: null,
    watch: 'watch',
    theme: 'system',
    backupRetentionDays: 7,
    onboarding: { dismissed: true, sessionStarted: true },
    about: { version: '1.0.0', update: null, checkOnStart: false },
    ...overrides
  };
}

export const entry = (
  overrides: Partial<ActivityEntry> & Pick<ActivityEntry, 'id'>
): ActivityEntry => ({
  time: Date.UTC(2026, 9, 18, 9, 30),
  kind: 'modify',
  path: 'src/a.ts',
  ...overrides
});

/** A fake `window.bridge`: every method a spy, state pushed with `push`. */
export function installBridge(initial: DesktopState = makeState(), activity: ActivityEntry[] = []) {
  let statusListener: ((state: DesktopState) => void) | null = null;
  let activityListener: ((entries: ActivityEntry[]) => void) | null = null;
  let menuListener: ((action: MenuAction) => void) | null = null;
  const detail: OpDetail = {
    opId: 'op-1',
    kind: 'modify',
    path: 'src/a.ts',
    time: 0,
    undone: false,
    before: 'one\ntwo\n',
    after: 'one\nthree\n'
  };
  const bridge = {
    version: '0.1.0',
    getStatus: vi.fn(async () => initial),
    onStatus: vi.fn((listener: (state: DesktopState) => void) => {
      statusListener = listener;
      return () => (statusListener = null);
    }),
    startPairing: vi.fn(async () => ({ code: '123456', expiresAt: Date.now() + 120_000 })),
    unpair: vi.fn(async () => undefined),
    openFolder: vi.fn(async () => ({ ok: false as const, reason: 'cancelled' as const })),
    openRecent: vi.fn(async () => ({ ok: true as const })),
    getActivity: vi.fn(async () => activity),
    onActivity: vi.fn((listener: (entries: ActivityEntry[]) => void) => {
      activityListener = listener;
      return () => (activityListener = null);
    }),
    undo: vi.fn(async () => ({ ok: true as const })),
    undoLast: vi.fn(async () => ({ ok: true as const })),
    setDenyPatterns: vi.fn(async () => true),
    setMode: vi.fn(async (mode) => mode),
    setAllowlist: vi.fn(async () => ({ ok: true as const })),
    setGatedPatterns: vi.fn(async () => ({ ok: true as const })),
    setEnvPatterns: vi.fn(async () => ({ ok: true as const })),
    setRunSettings: vi.fn(async () => true),
    setPathOverride: vi.fn(async () => true),
    cancelRun: vi.fn(async () => undefined),
    stopLoop: vi.fn(async () => undefined),
    onRunOutput: vi.fn(() => () => undefined),
    getOpDetail: vi.fn(async () => detail),
    getRunDetail: vi.fn(async () => null),
    setTheme: vi.fn(async () => true),
    setBackupRetention: vi.fn(async (days: number) => days >= 1 && days <= 90),
    openBackupsFolder: vi.fn(async () => true),
    clearBackups: vi.fn(async () => true),
    setOnboardingDismissed: vi.fn(async () => undefined),
    confirmPairing: vi.fn(async () => true),
    cancelPairing: vi.fn(async () => undefined),
    dismissAllowlistNote: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(async () => ({
      state: 'current' as const,
      version: '1.0.0',
      checkedAt: 0
    })),
    setCheckUpdatesOnStart: vi.fn(async () => undefined),
    onMenu: vi.fn((listener: (action: MenuAction) => void) => {
      menuListener = listener;
      return () => (menuListener = null);
    })
  } satisfies BridgeApi;
  Object.defineProperty(window, 'bridge', { value: bridge, configurable: true, writable: true });
  return {
    bridge,
    push: (state: DesktopState) => statusListener?.(state),
    pushActivity: (entries: ActivityEntry[]) => activityListener?.(entries),
    menu: (action: MenuAction) => menuListener?.(action)
  };
}
