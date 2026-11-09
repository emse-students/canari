// Break the app-wide import cycle (auth store -> composables -> mlsService -> subclasses ->
// BaseMlsService) that otherwise loads the concrete services before BaseMlsService is defined.
vi.mock('$lib/services/TauriMlsService', () => ({ TauriMlsService: class {} }));
vi.mock('$lib/services/WebMlsService', () => ({ WebMlsService: class {} }));
vi.mock('$lib/mls-client/mlsStatePersisterRegistry', () => ({
  persistMlsStructuralCheckpoint: vi.fn().mockResolvedValue(true),
  scheduleOutboundMlsPersist: vi.fn(),
}));

import { BaseMlsService } from './BaseMlsService';
import type { WelcomeRequestAnswer } from '$lib/mls-client/IMlsService';

/**
 * A `no_peer_online` answer to a welcome_request says whether the server lets a further device join
 * by itself (`selfJoin`, the gate of docs/wiki/protocols/mls-availability-no-holder.md). Only an
 * explicit `true` opens the door on the client; anything else is a wait for a member's Add.
 */
const proto = BaseMlsService.prototype as unknown as {
  sendWelcomeRequest(
    groupId: string,
    opts?: { selfJoinIfNobody?: boolean }
  ): Promise<WelcomeRequestAnswer>;
};

function serviceAnswering(answer: unknown) {
  const deliveryPost = vi.fn().mockResolvedValue(answer);
  return {
    deliveryPost,
    self: { userId: 'u1', deviceId: 'd1', delivery: { deliveryPost } },
  };
}

describe('sendWelcomeRequest - the stored answer carries the gate', () => {
  it('reads selfJoin only when the server says true', async () => {
    const open = serviceAnswering({ status: 'no_peer_online', selfJoin: true });
    await expect(proto.sendWelcomeRequest.call(open.self, 'g1')).resolves.toEqual({
      status: 'stored',
      selfJoin: true,
    });

    for (const answer of [
      { status: 'no_peer_online', selfJoin: false },
      { status: 'no_peer_online' },
      { status: 'no_peer_online', selfJoin: 'yes' },
    ]) {
      const shut = serviceAnswering(answer);
      await expect(proto.sendWelcomeRequest.call(shut.self, 'g1')).resolves.toEqual({
        status: 'stored',
      });
    }
  });

  it('sends the intent only when asked to', async () => {
    const s = serviceAnswering({ status: 'no_peer_online' });
    await proto.sendWelcomeRequest.call(s.self, 'g1', { selfJoinIfNobody: true });
    await proto.sendWelcomeRequest.call(s.self, 'g1');
    expect(s.deliveryPost).toHaveBeenNthCalledWith(1, 'welcome-request', {
      groupId: 'g1',
      requesterUserId: 'u1',
      requesterDeviceId: 'd1',
      selfJoinIfNobody: true,
    });
    expect(s.deliveryPost).toHaveBeenNthCalledWith(2, 'welcome-request', {
      groupId: 'g1',
      requesterUserId: 'u1',
      requesterDeviceId: 'd1',
    });
  });
});
