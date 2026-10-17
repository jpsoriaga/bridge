import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PAIRING_CODE_LENGTH, PairingCode, Token } from '@bridge/shared';
import { PAIRING_CODE_TTL_MS, PAIRING_LOCKOUT_MS, PAIRING_MAX_FAILURES } from './config';

/** Persists the SHA-256 hash of the current token. The token itself is never stored. */
export interface TokenHashStore {
  load(): Buffer | null;
  save(hash: Buffer | null): void;
}

export interface PendingCode {
  code: string;
  expiresAt: number;
}

export type RedeemResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'invalid_code' }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

export interface PairingOptions {
  store: TokenHashStore;
  now?: () => number;
  codeTtlMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * One-time codes, the single paired token, and the `/pair` lockout.
 * Pure Node so it can be tested without Electron.
 */
export class Pairing {
  private readonly store: TokenHashStore;
  private readonly now: () => number;
  private readonly codeTtlMs: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  private tokenHash: Buffer | null;
  private pending: PendingCode | null = null;
  private failures = 0;
  private lockedUntil = 0;

  constructor(options: PairingOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.codeTtlMs = options.codeTtlMs ?? PAIRING_CODE_TTL_MS;
    this.maxFailures = options.maxFailures ?? PAIRING_MAX_FAILURES;
    this.lockoutMs = options.lockoutMs ?? PAIRING_LOCKOUT_MS;
    this.tokenHash = options.store.load();
  }

  get isPaired(): boolean {
    return this.tokenHash !== null;
  }

  /** The live code, or null once it has expired or been used. */
  get pendingCode(): PendingCode | null {
    if (this.pending && this.now() >= this.pending.expiresAt) this.pending = null;
    return this.pending;
  }

  /** Remaining lockout, or 0. */
  get lockedForMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  /** Issues a fresh code, replacing any previous one. */
  startPairing(): PendingCode {
    const code = String(randomInt(0, 10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, '0');
    this.pending = { code, expiresAt: this.now() + this.codeTtlMs };
    return this.pending;
  }

  /** Exchanges a code for a new token. Replaces (revokes) any previous token. */
  redeem(candidate: string): RedeemResult {
    const locked = this.lockedForMs;
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };

    const pending = this.pendingCode;
    const matches =
      pending !== null &&
      PairingCode.safeParse(candidate).success &&
      timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(pending.code, 'utf8'));

    if (!matches) {
      this.failures += 1;
      if (this.failures >= this.maxFailures) {
        // Burn the code too, so one code never gets more than `maxFailures` guesses.
        this.failures = 0;
        this.pending = null;
        this.lockedUntil = this.now() + this.lockoutMs;
        return { ok: false, reason: 'locked', retryAfterMs: this.lockoutMs };
      }
      return { ok: false, reason: 'invalid_code' };
    }

    this.pending = null;
    this.failures = 0;
    const token = randomBytes(32).toString('hex');
    this.setHash(sha256(token));
    return { ok: true, token };
  }

  verifyToken(candidate: unknown): boolean {
    if (this.tokenHash === null || !Token.safeParse(candidate).success) return false;
    return timingSafeEqual(sha256(candidate as string), this.tokenHash);
  }

  unpair(): void {
    this.setHash(null);
  }

  private setHash(hash: Buffer | null): void {
    this.tokenHash = hash;
    this.store.save(hash);
  }
}

export function memoryTokenStore(initial: Buffer | null = null): TokenHashStore {
  let hash = initial;
  return {
    load: () => hash,
    save: (next) => {
      hash = next;
    }
  };
}
