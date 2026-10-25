import { isAbsentUserError, UserProfileFetchError } from './user';

/**
 * A 404 is an account's ABSENCE only when core-service said it: the session check sends the user to
 * the login page on it, and the profile cache keeps it. An edge's or a portal's "Not Found" page
 * says nothing about the account.
 */
describe('isAbsentUserError reads who answered', () => {
  it("is true for core-service's 404", () => {
    expect(isAbsentUserError(new UserProfileFetchError(404, 'gateway'))).toBe(true);
  });

  it("is false for an edge's 404", () => {
    expect(isAbsentUserError(new UserProfileFetchError(404, 'edge'))).toBe(false);
  });

  it('is false for any other status', () => {
    expect(isAbsentUserError(new UserProfileFetchError(500, 'gateway'))).toBe(false);
  });
});

/**
 * AT THE THROW: the origin is read from Nest's error envelope, because an edge in front of the estate
 * can answer in JSON too - and a JSON "Not Found" from it would otherwise send a live user to the
 * login page.
 */
describe('fetchUserProfile classifies a 404 by who wrote it', () => {
  const load = async (apiFetch: ReturnType<typeof vi.fn>) => {
    vi.resetModules();
    vi.doMock('$lib/utils/apiFetch', () => ({ apiFetch }));
    vi.doMock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://example.test' }));
    return import('./user');
  };

  it("core-service's envelope is an absence", { timeout: 20_000 }, async () => {
    const mod = await load(
      vi.fn(async () => Response.json({ statusCode: 404, message: 'Not Found' }, { status: 404 }))
    );
    const err = await mod.fetchUserProfile('me').catch((e: unknown) => e);
    expect(mod.isAbsentUserError(err)).toBe(true);
  });

  it("a JSON-speaking edge's 404 is not", { timeout: 20_000 }, async () => {
    const mod = await load(
      vi.fn(async () => Response.json({ status: 404, title: 'Not Found' }, { status: 404 }))
    );
    const err = await mod.fetchUserProfile('me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mod.UserProfileFetchError);
    expect(mod.isAbsentUserError(err)).toBe(false);
  });
});
