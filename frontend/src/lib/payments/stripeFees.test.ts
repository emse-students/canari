import { describe, expect, it } from 'vitest';
import {
  computeAssociationNetPayoutCents,
  computeStripeCardFeeCents,
  eurosInputToCents,
} from './stripeFees';

describe('stripeFees', () => {
  it('computes 0.25 € + 1.5 % on 10 €', () => {
    expect(computeStripeCardFeeCents(1000)).toBe(40);
    expect(computeAssociationNetPayoutCents(1000)).toBe(960);
  });

  it('returns zero fee for non-positive amounts', () => {
    expect(computeStripeCardFeeCents(0)).toBe(0);
    expect(computeAssociationNetPayoutCents(0)).toBe(0);
  });

  it('parses euro inputs', () => {
    expect(eurosInputToCents(10)).toBe(1000);
    expect(eurosInputToCents('')).toBeNull();
    expect(eurosInputToCents(0)).toBeNull();
  });
});
