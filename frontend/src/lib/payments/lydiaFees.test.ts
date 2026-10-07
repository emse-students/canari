import { computeLydiaFeeCents, computeLydiaNetPayoutCents, eurosInputToCents } from './lydiaFees';

describe('lydiaFees', () => {
  it('computes 0.10 € + 1 % on 10 €', () => {
    expect(computeLydiaFeeCents(1000)).toBe(20);
    expect(computeLydiaNetPayoutCents(1000)).toBe(980);
  });

  it('returns zero fee for non-positive amounts', () => {
    expect(computeLydiaFeeCents(0)).toBe(0);
    expect(computeLydiaNetPayoutCents(0)).toBe(0);
  });

  it('parses euro inputs', () => {
    expect(eurosInputToCents(10)).toBe(1000);
    expect(eurosInputToCents('')).toBeNull();
    expect(eurosInputToCents(0)).toBeNull();
  });
});
