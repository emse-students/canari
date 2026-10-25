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
