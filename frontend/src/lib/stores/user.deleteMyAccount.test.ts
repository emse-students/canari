import { describe, expect, it, vi } from 'vitest';
import type { ApiFetchOptions } from '$lib/utils/apiFetch';

/**
 * THE DELETED ACCOUNT IS THE TOKEN'S, NOT THE PAGE'S. `deleteMyAccount` reports the `sub` of the
 * bearer the server accepted, so the caller can refuse to wipe an account that was not deleted.
 */
let answer = 204;
let bearer = '';
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: async (_url: string, options: ApiFetchOptions = {}) => {
    options.onAuthorization?.(bearer);
    return new Response(null, { status: answer });
  },
}));

const { deleteMyAccount } = await import('./user');

const tokenFor = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`;

describe('deleteMyAccount', () => {
  it('returns the subject of the bearer the server accepted', async () => {
    answer = 204;
    bearer = tokenFor({ sub: 'user-b' });
    await expect(deleteMyAccount()).resolves.toEqual({ deletedSubject: 'user-b' });
  });

  it('returns no subject for a bearer naming nobody', async () => {
    answer = 204;
    bearer = 'not-a-jwt';
    await expect(deleteMyAccount()).resolves.toEqual({ deletedSubject: null });
  });

  it('throws on anything but 204', async () => {
    answer = 500;
    bearer = tokenFor({ sub: 'user-b' });
    await expect(deleteMyAccount()).rejects.toThrow('Account deletion failed (500)');
  });
});
