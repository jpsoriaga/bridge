import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PAIRING_CODE_LENGTH, PairingCode, Proof, proofInput } from '@bridge/shared';
import { PAIRING_CODE_TTL_MS, PAIRING_LOCKOUT_MS, PAIRING_MAX_FAILURES } from './config';

/**
 * Persists the SHA-256 hash of the current token, which is the HMAC key for every proof.
 * The token itself is never stored.
 */
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

export type ProofPurpose = Parameters<typeof proofInput>[1];

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const hmac = (key: Buffer, input: string) => createHmac('sha256', key).update(input).digest();

/**
 * One-time codes, the single paired key, its proofs, and the `/pair` lockout.
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

  /** HMAC over the client's nonce, proving this app holds the key. Null when unpaired. */
  serverProof(purpose: ProofPurpose, port: number, nonce: string): string | null {
    if (this.tokenHash === null) return null;
    return hmac(this.tokenHash, proofInput('server', purpose, port, nonce)).toString('hex');
  }

  /** Checks the client's HMAC over a nonce this app issued. Constant time. */
  verifyClientProof(purpose: ProofPurpose, port: number, nonce: string, proof: unknown): boolean {
    if (this.tokenHash === null || !Proof.safeParse(proof).success) return false;
    const expected = hmac(this.tokenHash, proofInput('client', purpose, port, nonce));
    return timingSafeEqual(Buffer.from(proof as string, 'hex'), expected);
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
