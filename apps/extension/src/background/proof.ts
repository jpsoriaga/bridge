import { FINGERPRINT_LABEL, formatFingerprint, PAIR_KEY_LABEL, proofInput } from '@bridge/shared';

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

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(...parts: (string | ArrayBuffer)[]): Promise<ArrayBuffer> {
  const chunks = parts.map((p) => (typeof p === 'string' ? encoder.encode(p) : new Uint8Array(p)));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return crypto.subtle.digest('SHA-256', all);
}

/** A one-time P-256 key pair for pairing, and its public key as the app expects it. */
export async function pairingKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits'
  ]);
  return {
    privateKey: pair.privateKey,
    publicKey: base64url(await crypto.subtle.exportKey('raw', pair.publicKey))
  };
}

/**
 * The pairing key (hex), the nonce both pairing proofs sign, and the fingerprint, from
 * the ECDH secret with the app's key and the transcript. The app computes the same.
 */
export async function derivePairing(
  privateKey: CryptoKey,
  serverKey: string,
  transcript: string
): Promise<{ key: string; nonce: string; fingerprint: string }> {
  const server = await crypto.subtle.importKey(
    'raw',
    fromBase64url(serverKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: server }, privateKey, 256);
  return {
    key: toHex(await sha256(PAIR_KEY_LABEL, shared, transcript)),
    nonce: toHex(await sha256(transcript)),
    fingerprint: formatFingerprint(toHex(await sha256(FINGERPRINT_LABEL, transcript)))
  };
}
