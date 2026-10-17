import { proofInput } from '@bridge/shared';

// Web Crypto, so this runs unchanged in the service worker and in Node tests.

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** 32 random bytes, hex. */
export function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** What the extension stores after pairing, in place of the token. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

function importKey(tokenHash: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromHex(tokenHash),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

type ProofArgs = Parameters<typeof proofInput>;

export async function signProof(tokenHash: string, ...args: ProofArgs): Promise<string> {
  const key = await importKey(tokenHash, 'sign');
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(proofInput(...args))));
}

/** `subtle.verify` compares in constant time. */
export async function verifyProof(
  tokenHash: string,
  proof: string,
  ...args: ProofArgs
): Promise<boolean> {
  const key = await importKey(tokenHash, 'verify');
  return crypto.subtle.verify('HMAC', key, fromHex(proof), encoder.encode(proofInput(...args)));
}
