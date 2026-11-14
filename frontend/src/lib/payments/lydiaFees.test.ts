import {
  computeLydiaFeeCents,
  computeLydiaNetPayoutCents,
  eurosInputToCents,
  type LydiaFeeSchedule,
} from './lydiaFees';

/**
 * The fee is the schedule an admin entered, HT, times (1 + VAT) - never a constant. Every rate here
 * is made up for the test and bears no relation to any real contract.
 */
const SCHEDULE: LydiaFeeSchedule = { percentBps: 300, fixedCents: 20, vatBps: 5_000 };

describe('lydiaFees', () => {
  it('applies the percentage and the fixed part, then the VAT', () => {
    // 10 EUR: HT 0.20 + 0.30 = 0.50, times 1.5 = 0.75.
    expect(computeLydiaFeeCents(1000, SCHEDULE)).toBe(75);
    expect(computeLydiaNetPayoutCents(1000, SCHEDULE)).toBe(925);
  });

  it('rounds once, to the nearest cent', () => {
    // 3.33 EUR: HT 0.20 + 0.0999 = 0.2999, times 1.5 = 0.44985 -> 0.45.
    expect(computeLydiaFeeCents(333, SCHEDULE)).toBe(45);
  });

  it('with no VAT, the fee is the HT one', () => {
    expect(computeLydiaFeeCents(1000, { ...SCHEDULE, vatBps: 0 })).toBe(50);
  });

  it('returns zero fee for non-positive amounts and never a negative net', () => {
    expect(computeLydiaFeeCents(0, SCHEDULE)).toBe(0);
    expect(computeLydiaNetPayoutCents(0, SCHEDULE)).toBe(0);
    expect(computeLydiaNetPayoutCents(10, { percentBps: 0, fixedCents: 100, vatBps: 0 })).toBe(0);
  });

  it('parses euro inputs', () => {
    expect(eurosInputToCents(10)).toBe(1000);
    expect(eurosInputToCents('')).toBeNull();
    expect(eurosInputToCents(0)).toBeNull();
  });
});
