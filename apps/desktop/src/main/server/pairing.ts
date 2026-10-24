import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomInt,
  timingSafeEqual,
  type KeyObject
} from 'node:crypto';
import {
  FINGERPRINT_LABEL,
  formatFingerprint,
  PAIR_KEY_LABEL,
  pairTranscript,
  PAIRING_CODE_LENGTH,
  PairingCode,
  Proof,
  proofInput,
  PublicKey
} from '@bridge/shared';
import { PAIRING_CODE_TTL_MS, PAIRING_LOCKOUT_MS, PAIRING_MAX_FAILURES } from './config';

/**
 * Persists the pairing key: 32 bytes both sides derived while pairing. It is the HMAC key
 * for every proof, and it never crosses the wire.
 */
export interface TokenHashStore {
  load(): Buffer | null;
  save(hash: Buffer | null): void;
}

/** The app's long-lived ECDH key pair, generated once (`fileServerKeyStore`). */
export interface ServerKey {
  privateKey: KeyObject;
  /** Uncompressed P-256 point, base64url, as `PublicKey` in shared. */
  publicKey: string;
}

export interface PendingCode {
  code: string;
  expiresAt: number;
}

/** What the app shows while pairing: the code, then the fingerprint to compare. */
export type PairingState =
  | { phase: 'code'; code: string; expiresAt: number }
  | { phase: 'compare'; fingerprint: string; expiresAt: number; confirmed: boolean };

export type RedeemResult =
  | { ok: true; publicKey: string; proof: string; fingerprint: string }
  | { ok: false; reason: 'invalid_code' | 'invalid_request' }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

export type ConfirmResult = 'paired' | 'not_confirmed' | 'no_pairing';

export interface PairingOptions {
  store: TokenHashStore;
  serverKey: ServerKey;
  now?: () => number;
  codeTtlMs?: number;
  maxFailures?: number;
  lockoutMs?: number;
}

export type ProofPurpose = Parameters<typeof proofInput>[1];

const sha256 = (...parts: (string | Buffer)[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const hmac = (key: Buffer, input: string) => createHmac('sha256', key).update(input).digest();

/** A fresh P-256 key pair for the app. */
export function generateServerKey(): ServerKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicKey: rawPublicKey(publicKey) };
}

/** A P-256 public key as an uncompressed point, base64url. */
export function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? '', 'base64url'),
    Buffer.from(jwk.y ?? '', 'base64url')
  ]);
  return point.toString('base64url');
}

/** The extension's public key from its base64url point, or null if it isn't a P-256 point. */
function importPublicKey(raw: string): KeyObject | null {
  if (!PublicKey.safeParse(raw).success) return null;
  const point = Buffer.from(raw, 'base64url');
  try {
    return createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url')
      },
      format: 'jwk'
    });
  } catch {
    return null;
  }
}

/** A code redeemed: the derived key, waiting for the user to compare fingerprints. */
interface Exchange {
  key: Buffer;
  /** SHA-256 of the transcript, hex: the nonce both pairing proofs sign. */
  nonce: string;
  port: number;
  fingerprint: string;
  expiresAt: number;
  /** The user confirmed the fingerprint in the app. */
  confirmed: boolean;
}

/**
 * One-time codes, the fingerprint exchange, the single paired key, its proofs, and the
 * `/pair` lockout. Pure Node so it can be tested without Electron.
 *
 * Pairing: the extension sends the code and a one-time ECDH public key; the app answers
 * with its own public key. Both derive the key from the shared secret and the transcript
 * (port, code, both keys) and show its fingerprint. The key is kept only after the user
 * confirms the fingerprint in the app and then the extension proves it holds the key.
 */
export class Pairing {
  private readonly store: TokenHashStore;
  private readonly serverKey: ServerKey;
  private readonly now: () => number;
  private readonly codeTtlMs: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  private tokenHash: Buffer | null;
  private pending: PendingCode | null = null;
  private exchange: Exchange | null = null;
  private failures = 0;
  private lockedUntil = 0;

  constructor(options: PairingOptions) {
    this.store = options.store;
    this.serverKey = options.serverKey;
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

  /** What the app shows: the code, the fingerprint to compare, or nothing. */
  get state(): PairingState | null {
    const exchange = this.liveExchange();
    if (exchange) {
      return {
        phase: 'compare',
        fingerprint: exchange.fingerprint,
        expiresAt: exchange.expiresAt,
        confirmed: exchange.confirmed
      };
    }
    const code = this.pendingCode;
    return code ? { phase: 'code', ...code } : null;
  }

  /** Remaining lockout, or 0. */
  get lockedForMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  /** Issues a fresh code, replacing any previous code or exchange. */
  startPairing(): PendingCode {
    const code = String(randomInt(0, 10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, '0');
    this.exchange = null;
    this.pending = { code, expiresAt: this.now() + this.codeTtlMs };
    return this.pending;
  }

  /** Drops the code or the exchange in progress. The paired key, if any, stays. */
  cancelPairing(): void {
    this.pending = null;
    this.exchange = null;
  }

  /**
   * Step 1: a code and the extension's public key. Derives the key and the fingerprint
   * but keeps nothing yet; the current pairing (if any) still works until step 2.
   */
  redeem(candidate: string, clientKey: string, port: number): RedeemResult {
    const locked = this.lockedForMs;
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const client = importPublicKey(clientKey);
    if (!client) return { ok: false, reason: 'invalid_request' };
    // Not six digits is a typo (a cut-off paste), not a guess: it doesn't count toward the
    // lockout. `/pair` refuses it before this, too.
    if (!PairingCode.safeParse(candidate).success) return { ok: false, reason: 'invalid_request' };

    const pending = this.pendingCode;
    const matches =
      pending !== null &&
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

    let shared: Buffer;
    try {
      shared = diffieHellman({ privateKey: this.serverKey.privateKey, publicKey: client });
    } catch {
      return { ok: false, reason: 'invalid_request' };
    }
    this.pending = null;
    this.failures = 0;
    const transcript = pairTranscript(port, candidate, this.serverKey.publicKey, clientKey);
    const key = sha256(PAIR_KEY_LABEL, shared, transcript);
    const nonce = sha256(transcript).toString('hex');
    const fingerprint = formatFingerprint(sha256(FINGERPRINT_LABEL, transcript).toString('hex'));
    this.exchange = {
      key,
      nonce,
      port,
      fingerprint,
      expiresAt: this.now() + this.codeTtlMs,
      confirmed: false
    };
    return {
      ok: true,
      publicKey: this.serverKey.publicKey,
      proof: hmac(key, proofInput('server', 'pair', port, nonce)).toString('hex'),
      fingerprint
    };
  }

  /** The user says the fingerprints match, in the app. Returns whether one was waiting. */
  confirmFingerprint(): boolean {
    const exchange = this.liveExchange();
    if (!exchange) return false;
    exchange.confirmed = true;
    return true;
  }

  /**
   * Step 2: the extension, whose user also confirmed, proves it derived the same key.
   * Only after the app's confirmation; then the key replaces any previous one.
   */
  confirmClient(proof: unknown): ConfirmResult {
    const exchange = this.liveExchange();
    if (!exchange || !Proof.safeParse(proof).success) return 'no_pairing';
    const expected = hmac(
      exchange.key,
      proofInput('client', 'pair', exchange.port, exchange.nonce)
    );
    if (!timingSafeEqual(Buffer.from(proof as string, 'hex'), expected)) {
      // Not the extension that sent the code: this exchange is done for.
      this.exchange = null;
      return 'no_pairing';
    }
    if (!exchange.confirmed) return 'not_confirmed';
    this.exchange = null;
    this.setHash(exchange.key);
    return 'paired';
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

  private liveExchange(): Exchange | null {
    if (this.exchange && this.now() >= this.exchange.expiresAt) this.exchange = null;
    return this.exchange;
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
