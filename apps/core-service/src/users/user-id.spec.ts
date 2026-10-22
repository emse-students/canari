import { BadRequestException, Logger } from '@nestjs/common';
import {
  assertMintableUserId,
  InvalidUserIdError,
  USER_ID_INVALID,
  userIdRuleBroken,
} from './user-id';

/**
 * A USER ID IS PRINTABLE ASCII WITH NO ':' BY CONSTRUCTION. Every comparison downstream lowercases
 * ASCII letters only (MLS's canonical identity, `userId:deviceId`), so a non-ASCII id would compare
 * differently on two sides, and a colon would break the one-colon device identity.
 */
describe('a user id', () => {
  it.each([
    ['the identity provider hashed subject', 'a'.repeat(64)],
    ['a plain ASCII id an administrator made', 'alice.b-1_2'],
    ['ASCII with uppercase letters and a space', 'Alice B'],
  ])('is mintable: %s', (_what, id) => {
    expect(userIdRuleBroken(id)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['empty', 42],
    ['not-printable-ascii', 'Élise'],
    ['not-printable-ascii', 'line\nbreak'],
    ['not-printable-ascii', 'tab\there'],
    ['colon', 'alice:dev-a'],
  ])('breaks the rule %s', (rule, id) => {
    expect(userIdRuleBroken(id)).toBe(rule);
  });

  it('is refused as a typed 400 naming the rule, logged at ERROR without the id', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const logger = new Logger('test');
    let thrown: unknown;
    try {
      assertMintableUserId('Élise-secret', logger, 'oidc-callback');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvalidUserIdError);
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as InvalidUserIdError).getResponse()).toMatchObject({
      code: USER_ID_INVALID,
      rule: 'not-printable-ascii',
    });
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('not-printable-ascii');
    expect(line).toContain('oidc-callback');
    expect(line).not.toContain('secret');
    expect(line).not.toContain('Élise');
    error.mockRestore();
  });

  it('passes a mintable id without a word', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    assertMintableUserId('f'.repeat(64), new Logger('test'), 'admin-create');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
