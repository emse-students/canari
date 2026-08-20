import { writePolicyAllows } from './permissions';

/**
 * ONE RULE, TWO CALLERS, AND THEY MUST NOT BE ABLE TO DISAGREE.
 *
 * `canWriteToChannel` enforces the policy per message; the workspace listing answers the same
 * question for the same viewer so the client can stop offering a composer the server will refuse.
 * Before 2026-08-20 only the first existed and the client knew nothing, so a member of an
 * admins-only salon was handed an editable composer and a 403 - found on production by COMM-7.
 *
 * The table below is the whole rule. It is asserted here rather than through the service because
 * the decision has no repository in it: what costs a query is finding out WHO the viewer is, and
 * that is deliberately not part of this function.
 */
describe('writePolicyAllows', () => {
  const NOBODY = { canManage: false, canModerate: false };
  const MODERATOR = { canManage: false, canModerate: true };
  const ADMIN = { canManage: true, canModerate: false };

  it('lets anyone write under the default policy', () => {
    expect(writePolicyAllows('everyone', NOBODY)).toBe(true);
    expect(writePolicyAllows('everyone', MODERATOR)).toBe(true);
    expect(writePolicyAllows('everyone', ADMIN)).toBe(true);
  });

  it('admits only administrators under admins', () => {
    expect(writePolicyAllows('admins', ADMIN)).toBe(true);
    expect(writePolicyAllows('admins', MODERATOR)).toBe(false);
    expect(writePolicyAllows('admins', NOBODY)).toBe(false);
  });

  it('admits moderators and administrators under admins_moderators', () => {
    expect(writePolicyAllows('admins_moderators', MODERATOR)).toBe(true);
    expect(writePolicyAllows('admins_moderators', ADMIN)).toBe(true);
    expect(writePolicyAllows('admins_moderators', NOBODY)).toBe(false);
  });

  /**
   * AN ADMINISTRATOR IS NOT REQUIRED TO ALSO CARRY THE MODERATION FLAG. Both are resolved from the
   * viewer's roles independently, and the one combination a caller could get wrong is an
   * administrator whose roles happen not to grant moderation - who must still be able to write in a
   * salon reserved for moderators.
   */
  it('does not require an administrator to be a moderator as well', () => {
    expect(writePolicyAllows('admins_moderators', { canManage: true, canModerate: false })).toBe(
      true
    );
  });
});
