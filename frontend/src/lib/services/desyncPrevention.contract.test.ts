/**
 * Contracts for docs/MLS_DESYNC_PREVENTION.md — commit baseEpoch must match server semantics.
 */
import { describe, it, expect } from 'vitest';
import { commitBaseEpochForValidation } from './mlsDesyncPrevention';

describe('desync prevention: commitBaseEpochForValidation', () => {
  it('matches POST /mls-api/commit expectation (local epoch N → baseEpoch N-1)', () => {
    expect(commitBaseEpochForValidation(0)).toBe(0);
    expect(commitBaseEpochForValidation(1)).toBe(0);
    expect(commitBaseEpochForValidation(5)).toBe(4);
  });

  it('floors non-integers and rejects invalid inputs to 0-base path', () => {
    expect(commitBaseEpochForValidation(3.9)).toBe(2);
    expect(commitBaseEpochForValidation(Number.NaN)).toBe(0);
    expect(commitBaseEpochForValidation(-1)).toBe(0);
  });
});
