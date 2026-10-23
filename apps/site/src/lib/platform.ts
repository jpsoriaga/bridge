// Which installer to offer first. The User-Agent string gives the system, but every Mac
// browser reports "Intel Mac OS X", so Apple silicon is only known from Chromium's
// User-Agent Client Hints (architecture "arm"). Safari and Firefox don't send them, so a
// Mac with an unknown chip gets the Apple silicon build first and the Intel one beside it.

export type Os = 'mac' | 'windows' | 'linux' | 'other';
export type Arch = 'arm64' | 'x64' | 'unknown';

export interface Detected {
  os: Os;
  arch: Arch;
}

/** The installers Bridge ships, one per system. */
export type Platform = 'mac-arm64' | 'mac-x64' | 'windows' | 'linux';

/** The high-entropy values asked for in `detectPlatform`. */
export interface ClientHints {
  platform?: string;
  architecture?: string;
  bitness?: string;
}

export function detectFromUserAgent(userAgent: string): Detected {
  const ua = userAgent;
  // Phones and tablets first: Android says "Linux", and iPadOS can say "Macintosh".
  if (/Android|iPhone|iPad|iPod|Mobile|CrOS/i.test(ua)) return { os: 'other', arch: 'unknown' };
  if (/Macintosh|Mac OS X/.test(ua)) return { os: 'mac', arch: 'unknown' };
  if (/Windows/.test(ua)) {
    return { os: 'windows', arch: /ARM64|aarch64/i.test(ua) ? 'arm64' : 'x64' };
  }
  if (/Linux|X11/.test(ua)) {
    return { os: 'linux', arch: /aarch64|arm/i.test(ua) ? 'arm64' : 'x64' };
  }
  return { os: 'other', arch: 'unknown' };
}

export function applyClientHints(base: Detected, hints: ClientHints): Detected {
  const os = hintOs(hints.platform) ?? base.os;
  const arch = hintArch(hints.architecture, hints.bitness) ?? base.arch;
  return { os, arch: os === 'other' ? 'unknown' : arch };
}

function hintOs(platform: string | undefined): Os | null {
  switch (platform) {
    case 'macOS':
      return 'mac';
    case 'Windows':
      return 'windows';
    case 'Linux':
      return 'linux';
    case 'Android':
    case 'iOS':
    case 'Chrome OS':
    case 'Chromium OS':
      return 'other';
    default:
      return null;
  }
}

function hintArch(architecture: string | undefined, bitness: string | undefined): Arch | null {
  if (architecture === 'arm') return 'arm64';
  if (architecture === 'x86') return bitness === '32' ? null : 'x64';
  return null;
}

/** The installer to show first, or null when Bridge has none for this system. */
export function primaryPlatform(detected: Detected): Platform | null {
  switch (detected.os) {
    case 'mac':
      return detected.arch === 'x64' ? 'mac-x64' : 'mac-arm64';
    case 'windows':
      // Windows on Arm runs the x64 build under emulation.
      return 'windows';
    case 'linux':
      return detected.arch === 'arm64' ? null : 'linux';
    default:
      return null;
  }
}

interface UADataLike {
  getHighEntropyValues?: (hints: string[]) => Promise<ClientHints>;
}

export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: UADataLike;
}

export async function detectPlatform(nav: NavigatorLike): Promise<Detected> {
  let detected = detectFromUserAgent(nav.userAgent);
  // iPadOS Safari asks for desktop sites with a Mac User-Agent; only touch gives it away.
  if (detected.os === 'mac' && (nav.maxTouchPoints ?? 0) > 1) {
    detected = { os: 'other', arch: 'unknown' };
  }
  const getHints = nav.userAgentData?.getHighEntropyValues;
  if (!getHints) return detected;
  try {
    const hints = await getHints.call(nav.userAgentData, ['platform', 'architecture', 'bitness']);
    return applyClientHints(detected, hints);
  } catch {
    return detected;
  }
}
