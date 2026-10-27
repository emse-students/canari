import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A SALON'S GRANTS AND REMOVALS ARE ORDERED BY THE SERVER'S ACCESS REVISION (2026-10-27). A leave
 * followed by a quick re-invitation is two broadcasts; a removal handled after the grant used to
 * purge a salon its user was back in. And the removal hands the actor's committing device on, so
 * the receivers can leave the key-group Remove to it.
 */

vi.mock('$lib/stores/typingStore.svelte', () => ({ setTyping: vi.fn() }));
vi.mock('$lib/stores/pinStore.svelte', () => ({ applyPin: vi.fn() }));
vi.mock('$lib/stores/pollStore.svelte', () => ({ setPollMeta: vi.fn() }));
vi.mock('$lib/stores/reactionStore.svelte', () => ({ applyChannelReactionFrame: vi.fn() }));
vi.mock('$lib/utils/graine/channelSeal', () => ({ openChannelMessage: vi.fn() }));
vi.mock('$lib/utils/chat/channelCrypto', () => ({ reportUnreadableChannelMessage: vi.fn() }));
vi.mock('$lib/proto/codec', () => ({ decodeAppMessage: vi.fn() }));
vi.mock('$lib/envelope', () => ({ serializeEnvelope: vi.fn(), mkTextEnvelope: vi.fn() }));
vi.mock('$lib/utils/chat/messageUtils', () => ({
  appMsgToEnvelope: vi.fn(),
  appMsgToChannelSystemEnvelope: vi.fn(),
}));
vi.mock('$lib/mls-client/incomingDelivery', () => ({ parseServerTimestampMs: vi.fn() }));

const { handleChannelEvent } = await import('./channelEventHandler');
const { salonGrants } = await import('$lib/utils/chat/memberRemoval');

const log = vi.fn();
const onChannelMemberKicked = vi.fn();
const onChannelRemovalReleased = vi.fn();
const ctx = () =>
  ({
    conversations: new Map(),
    onChannelMemberJoined: vi.fn(),
    onChannelMemberKicked,
    onChannelRemovalReleased,
    log,
    onOutOfSync: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const removal = (accessRevision?: number) => ({
  type: 'channel.member.removed',
  data: {
    channelId: 'salon-1',
    workspaceId: 'ws-1',
    removedUserId: 'bob',
    removedBy: 'bob',
    isPrivate: true,
    accessRevision,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  salonGrants.clear();
});

describe('a removal and a grant of the same salon', () => {
  it('ignores a removal older than a grant already seen for that person', async () => {
    await handleChannelEvent(
      {
        type: 'channel.member.joined',
        data: { channelId: 'salon-1', joinedBy: 'bob', accessRevision: 8 },
      },
      ctx()
    );
    await handleChannelEvent(removal(7), ctx());

    expect(onChannelMemberKicked).not.toHaveBeenCalled();
    expect(log.mock.calls.join('\n')).toContain('older than a grant already seen - ignored');
  });

  it('reads the people a grant names when it names several', async () => {
    await handleChannelEvent(
      {
        type: 'channel.member.joined',
        data: { channelId: 'salon-1', grantedUserIds: ['carol', 'Bob'], accessRevision: 8 },
      },
      ctx()
    );
    await handleChannelEvent(removal(7), ctx());
    expect(onChannelMemberKicked).not.toHaveBeenCalled();
  });

  it('acts on a removal newer than the grant, and on one of another person', async () => {
    await handleChannelEvent(
      {
        type: 'channel.member.joined',
        data: { channelId: 'salon-1', joinedBy: 'carol', accessRevision: 8 },
      },
      ctx()
    );
    await handleChannelEvent(removal(7), ctx());
    await handleChannelEvent(removal(9), ctx());
    expect(onChannelMemberKicked).toHaveBeenCalledTimes(2);
  });

  it('acts on a removal that carries no revision (an older server)', async () => {
    await handleChannelEvent(
      {
        type: 'channel.member.joined',
        data: { channelId: 'salon-1', joinedBy: 'bob', accessRevision: 8 },
      },
      ctx()
    );
    await handleChannelEvent(removal(undefined), ctx());
    expect(onChannelMemberKicked).toHaveBeenCalledOnce();
  });
});

describe('the removal hands on who performed it', () => {
  it('passes the actor and the committing device the server echoed', async () => {
    await handleChannelEvent(
      {
        type: 'channel.member.kicked',
        data: { workspaceId: 'ws-1', kickedUserId: 'bob', kickedBy: 'carol', actorDeviceId: 'w1' },
      },
      ctx()
    );
    expect(onChannelMemberKicked).toHaveBeenCalledWith(
      expect.objectContaining({ kickedUserId: 'bob', kickedBy: 'carol', actorDeviceId: 'w1' })
    );
  });
});

describe('a released Remove', () => {
  it('reaches the shell with its scope - an absent channel is the community', async () => {
    await handleChannelEvent(
      {
        type: 'channel.member.removal-released',
        data: { workspaceId: 'ws-1', channelId: null, removedUserId: 'bob', releasedBy: 'carol' },
      },
      ctx()
    );
    expect(onChannelRemovalReleased).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'ws-1',
      channelId: '',
      removedUserId: 'bob',
    });
  });

  it('is lost loudly, not silently, without the person it names', async () => {
    await handleChannelEvent(
      { type: 'channel.member.removal-released', data: { workspaceId: 'ws-1' } },
      ctx()
    );
    expect(onChannelRemovalReleased).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('arrived with no removedUserId'));
  });
});
