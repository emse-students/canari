import { computeLydiaFeeCents, computeLydiaNetPayoutCents } from './lydiaFees';

describe('lydiaFees', () => {
  it('computes 0.10 € + 1 % on 10 €', () => {
    expect(computeLydiaFeeCents(1000)).toBe(20);
    expect(computeLydiaNetPayoutCents(1000)).toBe(980);
  });

  it('returns zero fee for non-positive amounts', () => {
    expect(computeLydiaFeeCents(0)).toBe(0);
    expect(computeLydiaNetPayoutCents(0)).toBe(0);
  });
});
