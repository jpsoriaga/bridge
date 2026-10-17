import { describe, expect, it } from 'vitest';
import { IssuedNonces, newNonce, NonceLedger } from './nonces';

describe('NonceLedger', () => {
  it('accepts each nonce once within the window, then forgets it', () => {
    let clock = 0;
    const ledger = new NonceLedger(1_000, 10, () => clock);
    const n = newNonce();
    expect(ledger.claim(n)).toBe(true);
    expect(ledger.claim(n)).toBe(false);
    clock = 1_000;
    expect(ledger.claim(n)).toBe(true);
  });

  it('stays bounded', () => {
    const ledger = new NonceLedger(60_000, 3);
    const nonces = Array.from({ length: 5 }, newNonce);
    for (const n of nonces) expect(ledger.claim(n)).toBe(true);
    // The oldest were evicted; the newest are still remembered.
    expect(ledger.claim(nonces[0]!)).toBe(true);
    expect(ledger.claim(nonces[4]!)).toBe(false);
  });
});

describe('IssuedNonces', () => {
  it('redeems an issued nonce once, before it expires', () => {
    let clock = 0;
    const issued = new IssuedNonces(1_000, 10, () => clock);
    const a = issued.issue();
    const b = issued.issue();
    expect(issued.redeem(a)).toBe(true);
    expect(issued.redeem(a)).toBe(false);
    expect(issued.redeem(newNonce())).toBe(false);
    clock = 1_000;
    expect(issued.redeem(b)).toBe(false);
  });
});
