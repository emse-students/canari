import { describe, it, expect } from 'vitest';
import { isValidPin, MIN_PIN_LENGTH } from './pinValidation';

describe('isValidPin', () => {
  it('accepte un PIN de 4 chiffres exactement', () => {
    expect(isValidPin('1234')).toBe(true);
  });

  it('accepte un PIN de plus de 4 chiffres', () => {
    expect(isValidPin('123456')).toBe(true);
  });

  it('rejette un PIN de 3 chiffres', () => {
    expect(isValidPin('123')).toBe(false);
  });

  it('rejette un PIN vide', () => {
    expect(isValidPin('')).toBe(false);
  });

  it('rejette un PIN avec uniquement des espaces', () => {
    expect(isValidPin('   ')).toBe(false);
  });

  it('accepte un PIN avec des espaces autour (trim effectué en interne)', () => {
    expect(isValidPin(' 1234 ')).toBe(true);
  });

  it('utilise une constante MIN_PIN_LENGTH cohérente', () => {
    expect(MIN_PIN_LENGTH).toBe(4);
    expect(isValidPin('1'.repeat(MIN_PIN_LENGTH))).toBe(true);
    expect(isValidPin('1'.repeat(MIN_PIN_LENGTH - 1))).toBe(false);
  });
});
