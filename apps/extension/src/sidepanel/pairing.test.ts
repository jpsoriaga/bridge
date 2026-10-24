import { describe, expect, it } from 'vitest';
import { isFullCode, pairingDigits } from './pairing';

describe('pairingDigits', () => {
  it.each([
    ['160 508', '160508'],
    ['160-508', '160508'],
    [' 160508 ', '160508'],
    ['160 508\n', '160508'],
    ['Pairing code: 160 508', '160508'],
    ['1605089', '160508'],
    ['16 05', '1605'],
    ['abc', '']
  ])('%j → %j', (input, digits) => {
    expect(pairingDigits(input)).toBe(digits);
  });

  it('sends only six digits', () => {
    expect(isFullCode('160508')).toBe(true);
    expect(isFullCode('16050')).toBe(false);
    expect(isFullCode('')).toBe(false);
    expect(isFullCode('160 50')).toBe(false);
  });
});
