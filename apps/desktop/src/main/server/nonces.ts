import { randomBytes } from 'node:crypto';

export const newNonce = (): string => randomBytes(32).toString('hex');

/**
 * Remembers nonces for `ttlMs` so each is accepted once. Bounded: past `max` entries the
 * oldest are forgotten first, so a flood can't grow memory.
 */
export class NonceLedger {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now
  ) {}

  /** True the first time `nonce` is claimed within the window. */
  claim(nonce: string): boolean {
    this.prune();
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, this.now() + this.ttlMs);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(nonce);
    }
  }
}

/** Nonces this side hands out. Each can be redeemed once, before it expires. */
export class IssuedNonces {
  private readonly issued = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
    private readonly now: () => number = Date.now
  ) {}

  issue(): string {
    const nonce = newNonce();
    this.issued.set(nonce, this.now() + this.ttlMs);
    while (this.issued.size > this.max) this.issued.delete(this.issued.keys().next().value!);
    return nonce;
  }

  redeem(nonce: string): boolean {
    const expiresAt = this.issued.get(nonce);
    this.issued.delete(nonce);
    return expiresAt !== undefined && expiresAt > this.now();
  }
}
