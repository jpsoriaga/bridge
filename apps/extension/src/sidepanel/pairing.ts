import { PAIRING_CODE_LENGTH } from '@bridge/shared';

/**
 * The digits of a pairing code as typed or pasted, at most six. The app shows the code as
 * "160 508", so a paste brings the space (or a dash, or whitespace around it); only the
 * digits count, before the length limit, so nothing is cut off.
 */
export function pairingDigits(text: string): string {
  return text.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH);
}

/** A full code: the only kind the side panel sends. Shorter never counts as a try. */
export function isFullCode(code: string): boolean {
  return code.length === PAIRING_CODE_LENGTH && /^\d+$/.test(code);
}
