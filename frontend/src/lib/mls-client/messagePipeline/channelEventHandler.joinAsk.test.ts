import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE ASK OF AN INVITATION LINK, AND ITS OUTCOME, AS THE SOCKET DELIVERS THEM.
 *
 * chat-delivery announces a new ask to every online admitted member (`group.join_ask`), and its
 * outcome once a member answered (`group.join_ask.settled`). These two branches only route: the ask
 * is raised and the settlement applied by the callbacks the session wires.
 */

vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/utils/graine/channelSeal', () => ({ openChannelMessageProving: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: vi.fn() }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');

const log = vi.fn();
const onJoinAsk = vi.fn();
const onJoinAskSettled = vi.fn();

function ctx() {
  return {
    conversations: new Map(),
    addMessageToChat: vi.fn(),
    onJoinAsk,
    onJoinAskSettled,
    log,
    onOutOfSync: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const said = () => log.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => vi.clearAllMocks());

describe('group.join_ask', () => {
  it("hands the ask on, keeping only the asker's device ids that are strings", async () => {
    await handleChannelEvent(
      {
        type: 'group.join_ask',
        data: {
          groupId: 'g1',
          askId: 'a1',
          requesterUserId: 'joiner',
          requesterDeviceIds: ['d1', 7, '', 'd2'],
        },
      },
      ctx()
    );
    expect(onJoinAsk).toHaveBeenCalledWith({
      groupId: 'g1',
      askId: 'a1',
      requesterUserId: 'joiner',
      requesterDeviceIds: ['d1', 'd2'],
    });
  });

  it('says which address is missing, and raises nothing', async () => {
    await handleChannelEvent({ type: 'group.join_ask', data: { groupId: 'g1' } }, ctx());
    expect(onJoinAsk).not.toHaveBeenCalled();
    expect(said()).toContain('requesterUserId');
  });
});

describe('group.join_ask.settled', () => {
  it('hands the outcome on', async () => {
    await handleChannelEvent(
      {
        type: 'group.join_ask.settled',
        data: { groupId: 'g1', userId: 'joiner', askId: 'a1', outcome: 'declined' },
      },
      ctx()
    );
    expect(onJoinAskSettled).toHaveBeenCalledWith({
      groupId: 'g1',
      askId: 'a1',
      userId: 'joiner',
      outcome: 'declined',
    });
  });

  it('accuses an outcome it does not know, and leaves the ask on screen', async () => {
    await handleChannelEvent(
      {
        type: 'group.join_ask.settled',
        data: { groupId: 'g1', userId: 'joiner', askId: 'a1', outcome: 'maybe' },
      },
      ctx()
    );
    expect(onJoinAskSettled).not.toHaveBeenCalled();
    expect(said()).toContain('[ERROR]');
  });

  it('says which address is missing', async () => {
    await handleChannelEvent(
      {
        type: 'group.join_ask.settled',
        data: { userId: 'joiner', askId: 'a1', outcome: 'admitted' },
      },
      ctx()
    );
    expect(onJoinAskSettled).not.toHaveBeenCalled();
    expect(said()).toContain('groupId');
  });
});

/**
 * AN ASK IS SETTLED BY ITS IDENTITY (the seat id the server stamps on both frames), never by the order
 * frames arrive in - so a frame that does not carry it addresses nothing and is not handed on.
 */
describe('the ask identity', () => {
  it('raises no ask without one', async () => {
    await handleChannelEvent(
      { type: 'group.join_ask', data: { groupId: 'g1', requesterUserId: 'joiner' } },
      ctx()
    );
    expect(onJoinAsk).not.toHaveBeenCalled();
    expect(said()).toContain('askId');
  });

  it('settles nothing without one', async () => {
    await handleChannelEvent(
      {
        type: 'group.join_ask.settled',
        data: { groupId: 'g1', userId: 'joiner', outcome: 'expired' },
      },
      ctx()
    );
    expect(onJoinAskSettled).not.toHaveBeenCalled();
    expect(said()).toContain('askId');
  });

  it.each(['admitted', 'declined', 'expired', 'withdrawn'])(
    'hands a %s outcome on',
    async (outcome) => {
      await handleChannelEvent(
        {
          type: 'group.join_ask.settled',
          data: { groupId: 'g1', userId: 'joiner', askId: 'a1', outcome },
        },
        ctx()
      );
      expect(onJoinAskSettled).toHaveBeenCalledWith({
        groupId: 'g1',
        userId: 'joiner',
        askId: 'a1',
        outcome,
      });
    }
  );
});
