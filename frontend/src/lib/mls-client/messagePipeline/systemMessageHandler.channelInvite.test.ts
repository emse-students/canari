// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';
import { parseEnvelope } from '$lib/envelope';

/** Minimal context to exercise the `channel_invitation` path. */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set('dm1', { id: 'dm1', lifecycle: 'active', messages: [] });
  return {
    mlsService: {},
    storage: null,
    userId: 'alice',
    deviceKeyB64: 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => 'dm1',
    setSelectedContact: vi.fn(),
    onReadReceiptReceived: vi.fn(),
    log: vi.fn(),
    convo: { id: 'dm1', lifecycle: 'active', messages: [] },
    convoKey: 'dm1',
    senderNorm: 'alice',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

const INVITE_DATA = {
  channelId: 'chan-1',
  channelName: 'general',
  workspaceName: 'Les Rootz',
  inviterId: 'alice',
  inviterName: 'Alice',
  inviteeId: 'bob',
  inviteeName: 'Bob',
};

/** Pulls the envelope the handler passed to addMessageToChat. */
function insertedEnvelope(ctx: ReturnType<typeof makeCtx>) {
  expect(ctx.addMessageToChat).toHaveBeenCalledTimes(1);
  const [senderId, content, convoKey, options] = ctx.addMessageToChat.mock.calls[0];
  expect(senderId).toBe('system');
  expect(convoKey).toBe('dm1');
  expect(options).toMatchObject({ isSystem: true });
  const env = parseEnvelope(content);
  if (env.kind !== 'system') throw new Error(`expected a system envelope, got ${env.kind}`);
  return env;
}

describe('handleSystemEvent - channel_invitation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invitee -> actionable card: channelId present, no invitedName (Join button shows)', async () => {
    const ctx = makeCtx({ userId: 'bob', senderNorm: 'alice' });
    await handleSystemEvent('channel_invitation', INVITE_DATA, ctx as any);

    const env = insertedEnvelope(ctx);
    expect(env.channelInvite).toBeDefined();
    expect(env.channelInvite?.channelId).toBe('chan-1');
    expect(env.channelInvite?.inviterName).toBe('Alice');
    // The renderer keys the Join button off the ABSENCE of invitedName - see SystemEnvelope.
    expect(env.channelInvite?.invitedName).toBeUndefined();
  });

  it("inviter's other device -> same card, invitedName set (Join button suppressed)", async () => {
    const ctx = makeCtx({ userId: 'alice', senderNorm: 'alice' });
    await handleSystemEvent('channel_invitation', INVITE_DATA, ctx as any);

    const env = insertedEnvelope(ctx);
    // Was a plain text line before: the inviter got no card at all on any device.
    expect(env.channelInvite).toBeDefined();
    expect(env.channelInvite?.channelId).toBe('chan-1');
    expect(env.channelInvite?.invitedName).toBe('Bob');
    expect(env.text).toContain('Bob');
  });

  it('falls back to the channel name when the workspace name is absent', async () => {
    const ctx = makeCtx({ userId: 'bob', senderNorm: 'alice' });
    const { workspaceName: _omitted, ...noWorkspace } = INVITE_DATA;
    await handleSystemEvent('channel_invitation', noWorkspace, ctx as any);

    const env = insertedEnvelope(ctx);
    expect(env.channelInvite?.channelName).toBe('general');
    expect(env.channelInvite?.workspaceName).toBeUndefined();
  });

  it('ignores an invitation with no channelId (nothing to join)', async () => {
    const ctx = makeCtx({ userId: 'bob', senderNorm: 'alice' });
    await handleSystemEvent('channel_invitation', { ...INVITE_DATA, channelId: '' }, ctx as any);

    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
  });
});
