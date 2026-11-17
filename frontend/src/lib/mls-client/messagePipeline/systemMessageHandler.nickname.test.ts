// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => 'me' }));
vi.mock('$lib/users/blocks', () => ({ isBlockedWith: vi.fn(async () => false) }));

import { handleSystemEvent } from './systemMessageHandler';
import {
  NICKNAME_CLOCK_SKEW_MS,
  nicknameEntry,
  resetConversationNicknamesForTests,
} from '$lib/utils/users/conversationNicknames.svelte';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import {
  forgetHistoryAsks,
  noteHistoryAsk,
  noteJoinSolicited,
} from '$lib/utils/chat/historyAddressing';
import { historySealAad, mintHistoryAnswerKey, sealHistoryContent } from '$lib/crypto/historySeal';
import { fakeHistorySealEngine } from '$lib/mls-client/test/fixtures/fakeHistorySealEngine';
import { isRegisterOwed, noteRegisterOwed } from '$lib/utils/chat/registerOwed';

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

/**
 * THE NEWCOMER ASKS FOR ITS REGISTER (`registerOwed.ts`; history-answer-addressing.md, "The newcomer
 * asks for its register"): a device the join push never reached asks with a keyed digest carrying
 * `register`, and the elected responder answers with one SEALED frame holding the state. It is taken
 * like the push - unverified, current members only - and only when the sealed content says it is a
 * register answer to a register ask; the first one accepted clears the durable marker.
 */
describe('handleSystemEvent - the answer to OUR register ask', () => {
  const TO_ME = digestIdentity('me', 'device-me');
  const REQ = 'req-0000000a';
  const NICKNAMES = [{ userId: 'bob', nickname: 'Capitaine', setBy: 'ann', at: 10 }];
  const engine = fakeHistorySealEngine();
  const RESPONDER = {
    senderNorm: 'ann',
    deliveryMeta: {
      channel: 'live',
      addressed: true,
      senderDeviceId: 'a1',
      queuedCreatedAt: 1_000_000,
    },
    mlsService: {
      getDeviceId: () => 'device-me',
      historySealEngine: () => engine,
      getGroupMemberIdentities: vi.fn(async () => ['me:device-me', 'ann:a1', 'bob:b1']),
    },
  };

  /** Opens OUR digest ask (`register` or not) and returns what seals its answer. */
  async function ask(register: boolean) {
    const key = await mintHistoryAnswerKey(engine);
    noteHistoryAsk(
      'g1',
      REQ,
      { kind: 'digest', since: 0, askedAt: 1, ...(register ? { register: true } : {}) },
      key.secret
    );
    return (content: Record<string, unknown>) =>
      sealHistoryContent(
        engine,
        key.answerKey,
        historySealAad('g1', REQ, TO_ME, digestIdentity('ann', 'a1')),
        content
      );
  }

  beforeEach(() => {
    forgetHistoryAsks();
    noteRegisterOwed('me', 'g1');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('takes the register from the sealed answer, unverified, and stops asking', async () => {
    const seal = await ask(true);
    await handleSystemEvent(
      'history_bundle',
      {
        to: TO_ME,
        requestId: REQ,
        sealed: await seal({ messages: [], register: true, nicknames: NICKNAMES }),
      },
      makeCtx(RESPONDER) as any
    );

    expect(nicknameEntry('g1', 'bob')).toEqual({
      nickname: 'Capitaine',
      setBy: 'ann',
      at: 10,
      verified: false,
    });
    expect(isRegisterOwed('me', 'g1')).toBe(false);
  });

  it('takes no message from it - a register answer carries the state only', async () => {
    const seal = await ask(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(RESPONDER);
    await handleSystemEvent(
      'history_bundle',
      {
        to: TO_ME,
        requestId: REQ,
        sealed: await seal({
          messages: [{ id: 'm1', senderId: 'ann', content: 'x', timestamp: 500 }],
          register: true,
          nicknames: NICKNAMES,
        }),
      },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(error.mock.calls.join(' ')).toContain('it carries the state only');
  });

  it('an answer to a digest that did NOT ask for the register hands over no state, and the marker stays', async () => {
    const seal = await ask(false);
    await handleSystemEvent(
      'history_bundle',
      {
        to: TO_ME,
        requestId: REQ,
        sealed: await seal({ messages: [], register: true, nicknames: NICKNAMES }),
      },
      makeCtx(RESPONDER) as any
    );

    expect(nicknameEntry('g1', 'bob')).toBeNull();
    expect(isRegisterOwed('me', 'g1')).toBe(true);
  });

  it('`register` said in CLEAR beside a sealed answer is not believed - only the sealed content says it', async () => {
    const seal = await ask(true);
    await handleSystemEvent(
      'history_bundle',
      {
        to: TO_ME,
        requestId: REQ,
        register: true,
        sealed: await seal({ messages: [], nicknames: NICKNAMES }),
      },
      makeCtx(RESPONDER) as any
    );

    expect(nicknameEntry('g1', 'bob')).toBeNull();
    expect(isRegisterOwed('me', 'g1')).toBe(true);
  });

  it('an UNSEALED answer claiming to answer a register ask is taken as an ordinary answer, at error', async () => {
    await ask(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQ, register: true, messages: [], nicknames: NICKNAMES },
      makeCtx(RESPONDER) as any
    );

    expect(nicknameEntry('g1', 'bob')).toBeNull();
    expect(isRegisterOwed('me', 'g1')).toBe(true);
    expect(error.mock.calls.join(' ')).toContain('claims to answer a register ask');
  });

  it("the inviter's join push, accepted, clears the marker too", async () => {
    noteJoinSolicited('g1', 1);
    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: TO_ME, join: true, last: true },
      makeCtx({
        ...RESPONDER,
        senderNorm: 'inviter',
        deliveryMeta: { ...RESPONDER.deliveryMeta, senderDeviceId: 'inviter-device' },
      }) as any
    );

    expect(isRegisterOwed('me', 'g1')).toBe(false);
  });
});
