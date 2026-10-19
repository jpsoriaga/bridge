import { createECDH, createHash } from 'node:crypto';
import {
  FINGERPRINT_LABEL,
  formatFingerprint,
  PAIR_KEY_LABEL,
  pairTranscript
} from '@bridge/shared';

/**
 * The extension's half of pairing, in Node, for tests: a one-time P-256 key, and the key,
 * nonce and fingerprint it derives from the app's answer. Mirrors `derivePairing` in the
 * extension's background/proof.ts.
 */
export function pairingClient() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey().toString('base64url');
  return {
    publicKey,
    derive(port: number, code: string, serverKey: string) {
      const shared = ecdh.computeSecret(Buffer.from(serverKey, 'base64url'));
      const transcript = pairTranscript(port, code, serverKey, publicKey);
      const sha = (...parts: (string | Buffer)[]) => {
        const hash = createHash('sha256');
        for (const part of parts) hash.update(part);
        return hash.digest('hex');
      };
      return {
        key: sha(PAIR_KEY_LABEL, shared, transcript),
        nonce: sha(transcript),
        fingerprint: formatFingerprint(sha(FINGERPRINT_LABEL, transcript))
      };
    }
  };
}
