import { describe, expect, it, vi } from 'vitest';

const fetchUserProfile = vi.fn();
class FakeProfileError extends Error {
  constructor(readonly status: number) {
    super('profile');
  }
}
vi.mock('$lib/stores/user', () => ({
  fetchUserProfile: (id: string) => fetchUserProfile(id),
  UserProfileFetchError: FakeProfileError,
}));

const { checkSessionUserInBackground } = await import('./sessionProfileCheck');

describe('checkSessionUserInBackground', () => {
  it('redirects to login on a confirmed 404 only', async () => {
    fetchUserProfile.mockRejectedValue(new FakeProfileError(404));
    const redirect = vi.fn().mockResolvedValue(undefined);
    await checkSessionUserInBackground('user-1234', redirect);
    expect(redirect).toHaveBeenCalledOnce();
  });

  it.each([
    ['a 500', new FakeProfileError(500)],
    ['a transport failure', new TypeError('Failed to fetch')],
  ])('survives %s: a status is an answer, a transport failure is not a verdict', async (_n, e) => {
    fetchUserProfile.mockRejectedValue(e);
    const redirect = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await checkSessionUserInBackground('user-1234', redirect);
    expect(redirect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing on success', async () => {
    fetchUserProfile.mockResolvedValue({});
    const redirect = vi.fn();
    await checkSessionUserInBackground('user-1234', redirect);
    expect(redirect).not.toHaveBeenCalled();
  });
});
