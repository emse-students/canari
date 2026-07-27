import { describe, it, expect } from 'vitest';
import { isValidPin, isValidNewPin, MIN_PIN_LENGTH, MAX_PIN_LENGTH } from './pinValidation';

describe('isValidPin (unlock path)', () => {
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

  it('stays permissive for legacy PINs the creation policy would now reject', () => {
    // Longer than MAX_PIN_LENGTH, and alphanumeric: both were allowed before the policy and
    // must keep unlocking, otherwise their owners lose access to their own messages.
    expect(isValidPin('123456789012')).toBe(true);
    expect(isValidPin('correct-horse')).toBe(true);
  });

  it('uses a consistent MIN_PIN_LENGTH constant', () => {
    expect(MIN_PIN_LENGTH).toBe(4);
    expect(isValidPin('1'.repeat(MIN_PIN_LENGTH))).toBe(true);
    expect(isValidPin('1'.repeat(MIN_PIN_LENGTH - 1))).toBe(false);
  });
});

describe('isValidNewPin (creation path)', () => {
  it('accepts the policy bounds', () => {
    expect(isValidNewPin('1'.repeat(MIN_PIN_LENGTH))).toBe(true);
    expect(isValidNewPin('1'.repeat(MAX_PIN_LENGTH))).toBe(true);
  });

  it('rejects a PIN below the minimum', () => {
    expect(isValidNewPin('1'.repeat(MIN_PIN_LENGTH - 1))).toBe(false);
  });

  it('rejects a PIN above the maximum', () => {
    expect(isValidNewPin('1'.repeat(MAX_PIN_LENGTH + 1))).toBe(false);
  });

  it('rejects non-digit characters', () => {
    expect(isValidNewPin('12a4')).toBe(false);
    expect(isValidNewPin('12 34')).toBe(false);
    expect(isValidNewPin('correct-horse')).toBe(false);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isValidNewPin(' 1234 ')).toBe(true);
  });

  it('rejects an empty PIN', () => {
    expect(isValidNewPin('')).toBe(false);
  });
});
