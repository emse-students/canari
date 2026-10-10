import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IdentitySplitError,
  checkTokenIdentity,
  clearIdentitySplit,
  getIdentitySplit,
  isIdentitySplit,
} from './tokenIdentity.svelte';

function tokenFor(sub: string | undefined): string {
  return `h.${btoa(JSON.stringify({ sub }))}.s`;
}

afterEach(() => {
  clearIdentitySplit();
  vi.restoreAllMocks();
});

describe('checkTokenIdentity', () => {
  it('accepts a token whose sub is the local identity, case-insensitively', () => {
    expect(checkTokenIdentity(tokenFor('ABC-1'), 'abc-1')).toBe(true);
    expect(isIdentitySplit()).toBe(false);
  });

  it('latches the verdict on a mismatch and accuses with BOTH ids and nothing else', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(checkTokenIdentity(tokenFor('delta-id'), 'alpha-id')).toBe(false);

    expect(getIdentitySplit()).toEqual({ tokenSub: 'delta-id', localId: 'alpha-id' });
    const line = String(err.mock.calls[0][0]);
    expect(line).toContain('IDENTITY SPLIT');
    expect(line).toContain('delta-id');
    expect(line).toContain('alpha-id');
    expect(new IdentitySplitError(getIdentitySplit()!).split.localId).toBe('alpha-id');
  });

  it('has nothing to compare against without a local identity or a readable sub', () => {
    expect(checkTokenIdentity(tokenFor('delta-id'), null)).toBe(true);
    expect(checkTokenIdentity('not-a-jwt', 'alpha-id')).toBe(true);
    expect(checkTokenIdentity(tokenFor(undefined), 'alpha-id')).toBe(true);
    expect(isIdentitySplit()).toBe(false);
  });

  it('is void after a matching token or a sign-out', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkTokenIdentity(tokenFor('delta-id'), 'alpha-id');
    clearIdentitySplit();
    expect(isIdentitySplit()).toBe(false);

    checkTokenIdentity(tokenFor('delta-id'), 'alpha-id');
    expect(checkTokenIdentity(tokenFor('alpha-id'), 'alpha-id')).toBe(true);
    expect(isIdentitySplit()).toBe(false);
  });
});
