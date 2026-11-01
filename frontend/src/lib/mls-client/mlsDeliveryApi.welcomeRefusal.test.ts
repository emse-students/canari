import { describe, expect, it, vi } from 'vitest';
import {
  MlsDeliveryApi,
  WelcomeTargetNotMemberError,
  WelcomeTargetUnknownError,
  admitRefusalMakesWelcomeUndeliverable,
  isTerminalWelcomeRefusal,
  whyWelcomeUndeliverable,
} from './mlsDeliveryApi';

/**
 * A Welcome the server refuses because the roster does not name its target is TYPED at the throw,
 * from the body's `code` - a settlement stops owing it on that type, and a prose match would be the
 * one call site that understood the sentence.
 */
describe('sendWelcome and the refusal of its target', () => {
  function api(response: Response) {
    return new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(response) as unknown as typeof fetch,
    });
  }
  const send = (a: MlsDeliveryApi) => a.sendWelcome(new Uint8Array([1]), 'bob', 'group-1', 'd-b');

  it('throws WelcomeTargetNotMemberError on a 403 carrying WELCOME_TARGET_NOT_MEMBER', async () => {
    const body = JSON.stringify({
      code: 'WELCOME_TARGET_NOT_MEMBER',
      message: 'this Welcome is not accepted',
      error: 'welcome_target_not_member',
    });
    const err = await send(api(new Response(body, { status: 403 }))).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WelcomeTargetNotMemberError);
    expect(err).toMatchObject({ groupId: 'group-1', targetUserId: 'bob', targetDeviceId: 'd-b' });
  });

  it('keeps any other 403 an ordinary failure - the sender not a member is not this refusal', async () => {
    const body = JSON.stringify({ message: 'User alice is not a member of group group-1' });
    const err = await send(api(new Response(body, { status: 403 }))).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(WelcomeTargetNotMemberError);
  });

  it('throws WelcomeTargetUnknownError on a 404 carrying WELCOME_TARGET_UNKNOWN - a revoked target', async () => {
    const body = JSON.stringify({
      statusCode: 404,
      code: 'WELCOME_TARGET_UNKNOWN',
      message: 'this Welcome has no target device',
      error: 'welcome_target_unknown',
    });
    const err = await send(api(new Response(body, { status: 404 }))).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WelcomeTargetUnknownError);
    expect(isTerminalWelcomeRefusal(err)).toBe(true);
    expect(err).toMatchObject({ groupId: 'group-1', targetUserId: 'bob', targetDeviceId: 'd-b' });
  });

  it('keeps a 404 without that code an ordinary failure - an edge page is not this refusal', async () => {
    const err = await send(api(new Response('<html>not found</html>', { status: 404 }))).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(Error);
    expect(isTerminalWelcomeRefusal(err)).toBe(false);
  });
});

describe('which refused admits make a Welcome undeliverable - an allowlist', () => {
  // Each one a reason the delivery service's Welcome gate refuses by construction: no KeyPackage row
  // to resolve the target by, or a key group's member gate refusing the person.
  it.each(['no_key_package', 'unresolved_identity', 'not_entitled', 'departure_in_progress'])(
    'names %s, with why',
    (reason) => {
      expect(admitRefusalMakesWelcomeUndeliverable(reason)).toBe(true);
      expect(whyWelcomeUndeliverable(reason)).toEqual(expect.any(String));
    }
  );

  // A re-invite enrolled before its Welcome, a re-Add of a routed device, the committer itself, and
  // anything this build has never heard of: the Welcome is sent and answered as before.
  it.each([
    'not_enrolled',
    'already_active',
    'committer',
    'a-reason-added-later',
    'toString',
    'constructor',
  ])('leaves %s inert', (reason) => {
    expect(admitRefusalMakesWelcomeUndeliverable(reason)).toBe(false);
    expect(whyWelcomeUndeliverable(reason)).toBeNull();
  });
});
