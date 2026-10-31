import { describe, it, expect } from 'vitest';
import {
  applyAmountKey,
  bufferToCents,
  centsToBuffer,
  decimalSeparator,
  formatAmountCents,
  formatBuffer,
  type AmountKey,
} from './amountInput';

const type = (keys: AmountKey[]) => keys.reduce(applyAmountKey, '');

describe('applyAmountKey', () => {
  it('builds digits and drops a leading zero', () => {
    expect(type(['0', '0', '7'])).toBe('7');
    expect(type(['1', '2'])).toBe('12');
  });
  it('accepts one separator and two decimals only', () => {
    expect(type([',', '5'])).toBe('0,5');
    expect(type(['1', ',', '2', ',', '3', '4', '5'])).toBe('1,23');
  });
  it('backspace removes the last key, down to empty', () => {
    expect(type(['1', ',', '5', 'back', 'back'])).toBe('1');
    expect(type(['back'])).toBe('');
  });
  it('stops growing past the safe integer length without a price cap', () => {
    expect(type(Array(12).fill('9') as AmountKey[])).toBe('999999999');
  });
});

describe('bufferToCents', () => {
  it('is exact where a float is not', () => {
    expect(bufferToCents('1,15')).toBe(115);
    expect(bufferToCents('12,5')).toBe(1250);
    expect(bufferToCents('20')).toBe(2000);
    expect(bufferToCents('0,')).toBeUndefined();
  });
  it('treats empty and zero as nothing to charge', () => {
    expect(bufferToCents('')).toBeUndefined();
    expect(bufferToCents('0')).toBeUndefined();
  });
});

describe('centsToBuffer', () => {
  it('round-trips with bufferToCents', () => {
    for (const cents of [100, 1250, 1205, 5000, 1]) {
      expect(bufferToCents(centsToBuffer(cents))).toBe(cents);
    }
    expect(centsToBuffer(1250)).toBe('12,5');
  });
});

describe('formatting', () => {
  it('formats with the locale, not toFixed', () => {
    expect(formatAmountCents(1500, 'eur', 'fr').replace(/\s/g, ' ')).toBe('15,00 \u20ac');
    expect(formatAmountCents(1500, 'eur', 'en')).toBe('\u20ac15.00');
  });
  it('trims a whole amount for chips', () => {
    expect(formatAmountCents(500, 'eur', 'en', true)).toBe('\u20ac5');
    expect(formatAmountCents(550, 'eur', 'en', true)).toBe('\u20ac5.50');
  });
  it('shows the typed buffer with the locale separator', () => {
    expect(formatBuffer('12,5', 'en')).toBe('12.5');
    expect(formatBuffer('', 'fr')).toBe('0');
    expect(decimalSeparator('fr')).toBe(',');
  });
});
