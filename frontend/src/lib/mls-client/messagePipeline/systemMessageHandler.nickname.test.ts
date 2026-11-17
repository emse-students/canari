// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'me' }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { handleSystemEvent } from './systemMessageHandler';
import { mkNoticeEnvelope, serializeEnvelope } from '$lib/envelope';
import {
  NICKNAME_CLOCK_SKEW_MS,
  nicknameEntry,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import { forgetHistoryAsks, noteJoinSolicited } from '$lib/utils/chat/historyAddressing';

/**
 * "MODIFIER LES PSEUDOS" ON THE LIVE PATH: the silent `nickname` frame, and the register a
 * `history_bundle` restates for a member admitted after the frame went out.
 */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const conversations = new Map<string, any>();
  conversations.set('g1', { id: 'g1', unreadCount: 0, readWatermarks: {}, messages: [] });
  return {
    mlsService: {
      getDeviceId: () => 'device-me',
      getGroupMemberIdentities: vi.fn(async () => [
        'me:device-me',
        'ann:a1',
        'bob:b1',
        'cy:c1',
        'inviter:inviter-device',
      ]),
    },
    // Every copy carries its server time (the queue row's, forwarded live by the gateway).
    deliveryMeta: { queuedCreatedAt: 1_000_000 },
    storage: null,
    userId: 'me',
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn(),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn(),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getSelectedContact: () => null,
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convo: conversations.get('g1'),
    convoKey: 'g1',
    senderNorm: 'ann',
    persistMlsStateNow: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetConversationNicknamesForTests();
});

describe('handleSystemEvent - nickname', () => {
  it('applies the frame with the MLS sender as setter, and adds no message to the thread', async () => {
    const ctx = makeCtx();
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'Capitaine', at: 10, setBy: 'forged' },
      ctx as any
    );
    expect(nicknameEntry('g1', 'bob')).toEqual({
      nickname: 'Capitaine',
      setBy: 'ann',
      at: 10,
      verified: true,
    });
    expect(ctx.addMessageToChat).not.toHaveBeenCalled();
    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
  });

  it('applies a reset', async () => {
    const ctx = makeCtx();
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'Capitaine', at: 10 },
      ctx as any
    );
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: null, at: 11 },
      makeCtx({ senderNorm: 'bob' }) as any
    );
    expect(nicknameEntry('g1', 'bob')).toEqual({
      nickname: null,
      setBy: 'bob',
      at: 11,
      verified: true,
    });
  });
});

describe('handleSystemEvent - history_bundle restates the nicknames', () => {
  const TO_ME = digestIdentity('me', 'device-me');
  const JOIN_PUSH = {
    senderNorm: 'inviter',
    deliveryMeta: {
      channel: 'live',
      addressed: true,
      senderDeviceId: 'inviter-device',
      queuedCreatedAt: 1_000_000,
    },
    mlsService: {
      getDeviceId: () => 'device-me',
      getGroupMemberIdentities: vi.fn(async () => [
        'me:device-me',
        'inviter:inviter-device',
        'ann:a1',
        'bob:b1',
      ]),
    },
  };
  const NICKNAMES = [{ userId: 'bob', nickname: 'Capitaine', setBy: 'ann', at: 10 }];

  beforeEach(() => forgetHistoryAsks());

  it("the inviter's join push hands a late joiner the register, unverified", async () => {
    noteJoinSolicited('g1', 1);
    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: TO_ME, join: true, last: true, nicknames: NICKNAMES },
      makeCtx(JOIN_PUSH) as any
    );
    expect(nicknameEntry('g1', 'bob')).toEqual({
      nickname: 'Capitaine',
      setBy: 'ann',
      at: 10,
      verified: false,
    });
  });

  it('a broadcast bundle carries no nicknames - its relayer could forge any setter', async () => {
    await handleSystemEvent(
      'history_bundle',
      { messages: [], nicknames: NICKNAMES },
      makeCtx({ senderNorm: 'inviter' }) as any
    );
    expect(nicknameEntry('g1', 'bob')).toBeNull();
  });

  it('an entry naming no member of the tree is refused', async () => {
    noteJoinSolicited('g1', 1);
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: TO_ME,
        join: true,
        last: true,
        nicknames: [{ userId: 'stranger', nickname: 'Faux', setBy: 'ann', at: 10 }],
      },
      makeCtx(JOIN_PUSH) as any
    );
    expect(nicknameEntry('g1', 'stranger')).toBeNull();
  });

  it('keeps an entry whose setter has left - a nickname stays when its setter leaves', async () => {
    noteJoinSolicited('g1', 1);
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: TO_ME,
        join: true,
        last: true,
        nicknames: [{ userId: 'bob', nickname: 'Reste', setBy: 'gone', at: 10 }],
      },
      makeCtx(JOIN_PUSH) as any
    );
    expect(nicknameEntry('g1', 'bob')?.nickname).toBe('Reste');
  });

  it('does not let a bundle overrule a frame already applied', async () => {
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'New', at: 5 },
      makeCtx() as any
    );
    noteJoinSolicited('g1', 1);
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: TO_ME,
        join: true,
        last: true,
        nicknames: [{ userId: 'bob', nickname: 'Old', setBy: 'ann', at: 10 }],
      },
      makeCtx(JOIN_PUSH) as any
    );
    expect(nicknameEntry('g1', 'bob')?.nickname).toBe('New');
  });
});

describe('handleSystemEvent - nickname, held to the tree and to the server time', () => {
  it('refuses a frame naming a target outside the tree, and one the tree cannot be read for', async () => {
    const error = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx();
    await handleSystemEvent('nickname', { userId: 'stranger', nickname: 'X', at: 1 }, ctx as any);
    expect(nicknameEntry('g1', 'stranger')).toBeNull();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('REFUSED'));
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'X', at: 1 },
      makeCtx({
        mlsService: {
          getDeviceId: () => 'device-me',
          getGroupMemberIdentities: vi.fn(async () => {
            throw new Error('no group');
          }),
        },
      }) as any
    );
    expect(nicknameEntry('g1', 'bob')).toBeNull();
    error.mockRestore();
  });

  it('refuses a frame that carries no server time - never bounded by this clock', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'X', at: 1 },
      makeCtx({ deliveryMeta: undefined }) as any
    );
    expect(nicknameEntry('g1', 'bob')).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('no server time'));
    error.mockRestore();
  });
});

describe('handleSystemEvent - nickname, the sender clock', () => {
  it('a future-dated frame is bounded by its server time, so a reset after it wins', async () => {
    const queuedCreatedAt = 1_000_000;
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: 'Gel', at: 9e15 },
      makeCtx({ deliveryMeta: { queuedCreatedAt } }) as any
    );
    expect(nicknameEntry('g1', 'bob')?.at).toBe(queuedCreatedAt + NICKNAME_CLOCK_SKEW_MS);
    const later = queuedCreatedAt + 2 * NICKNAME_CLOCK_SKEW_MS;
    await handleSystemEvent(
      'nickname',
      { userId: 'bob', nickname: null, at: later },
      makeCtx({ senderNorm: 'bob', deliveryMeta: { queuedCreatedAt: later } }) as any
    );
    expect(nicknameEntry('g1', 'bob')?.nickname).toBeNull();
  });
});

describe('handleSystemEvent - history_bundle restates the dated group name (groupName.ts)', () => {
  const TO_ME = digestIdentity('me', 'device-me');
  const JOIN_PUSH = {
    senderNorm: 'inviter',
    deliveryMeta: {
      channel: 'live',
      addressed: true,
      senderDeviceId: 'inviter-device',
      queuedCreatedAt: 1_000_000,
    },
  };
  const groupRow = (ctx: ReturnType<typeof makeCtx>) => {
    ctx.conversations.set('g1', {
      ...ctx.conversations.get('g1'),
      name: 'Groupe',
      conversationType: 'group',
    });
    return ctx;
  };

  beforeEach(() => forgetHistoryAsks());

  it("the inviter's join push names the group for a member admitted after the last rename", async () => {
    noteJoinSolicited('g1', 1);
    const ctx = groupRow(makeCtx(JOIN_PUSH));
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: TO_ME,
        join: true,
        last: true,
        groupName: { name: 'Les ROOTz', at: 900_000 },
      },
      ctx as any
    );
    expect(ctx.conversations.get('g1')).toMatchObject({ name: 'Les ROOTz', nameAt: 900_000 });
  });

  it('a date later than the push carrying it is refused at ERROR', async () => {
    noteJoinSolicited('g1', 1);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = groupRow(makeCtx(JOIN_PUSH));
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [],
        to: TO_ME,
        join: true,
        last: true,
        groupName: { name: 'Faux', at: 2_000_000 },
      },
      ctx as any
    );
    expect(ctx.conversations.get('g1').name).toBe('Groupe');
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('[GROUP_NAME] REFUSED');
    error.mockRestore();
  });

  it('a restated name never beats a name a frame already dated here - an inviter cannot rename for the newcomer', async () => {
    noteJoinSolicited('g1', 1);
    const ctx = groupRow(makeCtx(JOIN_PUSH));
    ctx.conversations.set('g1', {
      ...ctx.conversations.get('g1'),
      name: 'Les ROOTz',
      nameAt: 800_000,
    });
    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: TO_ME, join: true, last: true, groupName: { name: 'Faux', at: 999_999 } },
      ctx as any
    );
    expect(ctx.conversations.get('g1')).toMatchObject({ name: 'Les ROOTz', nameAt: 800_000 });
  });

  // THE HEAL A DROPPED RE-SEND RELIES ON (#3785 re-review 2). This device renamed to "A", its send
  // got no answer and it stopped re-sending; the frame landed at t1 all the same, and every member
  // holds its notice under the id this device minted. This device holds no row under that id, so the
  // digest diff relays it - and the relayed row applies (A, t1) here, by the ordinary rule.
  it("a relayed copy of this device's own rename notice applies (A, t1): the members' name, at their time", async () => {
    const ctx = groupRow(makeCtx({ senderNorm: 'ann' }));
    // No exclusion window holds this device out of anything (`dropOwnExcludedMessages`).
    Object.assign(ctx.mlsService, {
      getGroupWithheld: vi.fn().mockResolvedValue(new Map([['me', []]])),
    });
    ctx.conversations.set('g1', {
      ...ctx.conversations.get('g1'),
      name: 'Groupe',
      nameAt: 700_000,
      nameSync: {
        unconfirmed: {
          name: 'A',
          messageId: 'own-rename-1',
          sentAt: 899_000,
          over: { name: 'Groupe', at: 700_000 },
        },
      },
    });
    const notice = serializeEnvelope(
      mkNoticeEnvelope('me renamed the group to A', {
        event: 'groupRenamed',
        actor: 'me',
        name: 'A',
      })
    );
    await handleSystemEvent(
      'history_bundle',
      {
        messages: [
          {
            id: 'own-rename-1',
            senderId: 'system',
            content: notice,
            timestamp: 899_000,
            serverTimestamp: 900_000,
          },
        ],
      },
      ctx as any
    );
    expect(ctx.conversations.get('g1')).toMatchObject({ name: 'A', nameAt: 900_000 });
    expect(ctx.conversations.get('g1').nameSync).toEqual({
      serverCopy: { name: 'A', from: 'Groupe' },
    });
  });

  it('a broadcast bundle names nothing - only the join push restates the name', async () => {
    const ctx = groupRow(makeCtx({ senderNorm: 'inviter' }));
    await handleSystemEvent(
      'history_bundle',
      { messages: [], groupName: { name: 'Les ROOTz', at: 900_000 } },
      ctx as any
    );
    expect(ctx.conversations.get('g1').name).toBe('Groupe');
  });
});
