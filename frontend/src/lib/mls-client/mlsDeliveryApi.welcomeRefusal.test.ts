import { describe, expect, it, vi } from 'vitest';
import { MlsDeliveryApi, WelcomeTargetNotMemberError } from './mlsDeliveryApi';

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
});
