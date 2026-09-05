import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN EVENT OF A TYPE THIS CLIENT HANDLES, LOST BECAUSE ITS ADDRESS IS ABSENT.
 *
 * The dispatcher's tail already accuses on an unhandled TYPE - "silent data loss dressed as a
 * no-op", in its own words. Five branches did exactly that one level down: they returned on a
 * missing id and said nothing, so a `workspace.role.changed` with no `workspaceId` left a demoted
 * administrator holding every control they had just lost, with no line anywhere.
 *
 * ONE OF THE FIVE GUARDS WAS ALSO DEAD. `channel.typing` builds its key as
 * `` `channel_${data.channelId || ''}` `` and then tested THAT for emptiness - which is the string
 * `'channel_'` when the id is missing, and truthy. So the guard could never fire for half the events
 * it covered, and `setTyping` wrote a typing indicator under a key naming no channel. The emptiness
 * to test is the SERVER's field, never a key this client has already prefixed.
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

const { setTyping } = await import('$lib/stores/typingStore.svelte');
const { applyPin } = await import('$lib/stores/pinStore.svelte');
const { setPollMeta } = await import('$lib/stores/pollStore.svelte');
const { handleChannelEvent } = await import('./channelEventHandler');

const log = vi.fn();

/** The context the dispatcher destructures; every callback is observable and nothing else is used. */
function ctx(extra: Record<string, unknown> = {}) {
  return {
    conversations: new Map(),
    addMessageToChat: vi.fn(),
    onChannelMemberJoined: vi.fn(),
    onChannelMemberKicked: vi.fn(),
    onChannelUpdated: vi.fn(),
    onRolePermissionsChanged: vi.fn(),
    onChannelDeleted: vi.fn(),
    onWorkspaceUpdated: vi.fn(),
    onWorkspaceRoleChanged: vi.fn(),
    onWorkspaceDeleted: vi.fn(),
    onChannelMessageDeleted: vi.fn(),
    log,
    onOutOfSync: vi.fn(),
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Every line the dispatcher wrote, joined - the report is what these tests are about. */
const said = () => log.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => vi.clearAllMocks());

describe('an event whose address is missing', () => {
  it('does not write a typing indicator under a key naming no channel - THE DEAD GUARD', async () => {
    await handleChannelEvent({ type: 'channel.typing', data: { userId: 'u1' } }, ctx());
    expect(setTyping).not.toHaveBeenCalled();
    expect(said()).toContain('channelId');
  });

  it('still writes one when the channel IS named, under the prefixed key', async () => {
    await handleChannelEvent(
      { type: 'channel.typing', data: { userId: 'u1', channelId: 'c9', state: 'start' } },
      ctx()
    );
    expect(setTyping).toHaveBeenCalledWith('channel_c9', 'u1', true);
    expect(said()).toBe('');
  });

  it('accuses on a DM typing signal with no group', async () => {
    await handleChannelEvent({ type: 'typing', data: { userId: 'u1' } }, ctx());
    expect(setTyping).not.toHaveBeenCalled();
    expect(said()).toContain('groupId');
  });

  it('accuses on a typing signal with no user, naming that field and not another', async () => {
    await handleChannelEvent({ type: 'typing', data: { groupId: 'g1' } }, ctx());
    expect(said()).toContain('userId');
    expect(said()).not.toContain('groupId');
  });

  it('accuses on a pin that names no message, and applies none', async () => {
    await handleChannelEvent({ type: 'channel.pin', data: { channelId: 'c9' } }, ctx());
    expect(applyPin).not.toHaveBeenCalled();
    expect(said()).toContain('messageId');
  });

  it('accuses on a poll tally with no tally', async () => {
    await handleChannelEvent({ type: 'channel.poll.vote', data: { messageId: 'm1' } }, ctx());
    expect(setPollMeta).not.toHaveBeenCalled();
    expect(said()).toContain('poll');
  });

  it('accuses when a role change names no community - the demoted admin case', async () => {
    const onWorkspaceRoleChanged = vi.fn();
    await handleChannelEvent(
      { type: 'workspace.role.changed', data: { roleName: 'member' } },
      ctx({ onWorkspaceRoleChanged })
    );
    expect(onWorkspaceRoleChanged).not.toHaveBeenCalled();
    expect(said()).toContain('workspaceId');
  });

  it('accuses when a permission change names no role', async () => {
    const onRolePermissionsChanged = vi.fn();
    await handleChannelEvent(
      { type: 'workspace.role.permissions', data: { permissions: ['workspace.manage'] } },
      ctx({ onRolePermissionsChanged })
    );
    expect(onRolePermissionsChanged).not.toHaveBeenCalled();
    expect(said()).toContain('roleId');
  });

  it('every one of them accuses at ERROR, so none can be read as informational', async () => {
    await handleChannelEvent({ type: 'typing', data: {} }, ctx());
    expect(said()).toContain('[ERROR]');
  });
});

describe('the tail that was already there', () => {
  it('still accuses on a type no branch handles', async () => {
    await handleChannelEvent({ type: 'channel.something.new', data: {} }, ctx());
    expect(said()).toContain('Unhandled channel event type');
  });
});
