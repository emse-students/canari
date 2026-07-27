import { describe, it, expect } from 'vitest';
import { isValidPin, MIN_PIN_LENGTH } from './pinValidation';

describe('isValidPin', () => {
  it('accepts a PIN of exactly 4 digits', () => {
    expect(isValidPin('1234')).toBe(true);
  });

  it('accepts a PIN longer than 4 digits', () => {
    expect(isValidPin('123456')).toBe(true);
  });

  it('rejects a PIN of 3 digits', () => {
    expect(isValidPin('123')).toBe(false);
  });

  it('rejects an empty PIN', () => {
    expect(isValidPin('')).toBe(false);
  });

  it('rejects a whitespace-only PIN', () => {
    expect(isValidPin('   ')).toBe(false);
  });

  it('trims surrounding whitespace before measuring', () => {
    expect(isValidPin(' 1234 ')).toBe(true);
  });

  it('imposes no upper bound and no character-set restriction', () => {
    // The device key derives from the exact string typed, so anything the user was ever
    // allowed to choose must stay enterable at unlock.
    expect(isValidPin('123456789012')).toBe(true);
    expect(isValidPin('correct-horse')).toBe(true);
  });

  it('uses a consistent MIN_PIN_LENGTH constant', () => {
    expect(MIN_PIN_LENGTH).toBe(4);
    expect(isValidPin('1'.repeat(MIN_PIN_LENGTH))).toBe(true);
    expect(isValidPin('1'.repeat(MIN_PIN_LENGTH - 1))).toBe(false);
  });
});
