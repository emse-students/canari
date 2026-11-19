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
import {
  forgetHistoryAsks,
  noteHistoryAsk,
  noteJoinSolicited,
} from '$lib/utils/chat/historyAddressing';
import { historySealAad, mintHistoryAnswerKey, sealHistoryContent } from '$lib/crypto/historySeal';
import { fakeHistorySealEngine } from '$lib/mls-client/test/fixtures/fakeHistorySealEngine';
import {
  REGISTER_ASKS_MAX,
  endSpentRegisterAsks,
  isRegisterOwed,
  noteRegisterAsked,
  noteRegisterOwed,
  registerNeverTaken,
} from '$lib/utils/chat/registerOwed';

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
    noteJoinSolicited('g1', 'inviter', 1);
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
    noteJoinSolicited('g1', 'inviter', 1);
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
    noteJoinSolicited('g1', 'inviter', 1);
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
    noteJoinSolicited('g1', 'inviter', 1);
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
    noteJoinSolicited('g1', 'inviter', 1);
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
    noteJoinSolicited('g1', 'inviter', 1);
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
    noteJoinSolicited('g1', 'inviter', 1);
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

  it('a DECLINE gives its ask back, takes nothing, and leaves the register owed (P2-b)', async () => {
    for (let i = 0; i < REGISTER_ASKS_MAX; i++) noteRegisterAsked('me', 'g1');
    const seal = await ask(true);
    const ctx = makeCtx(RESPONDER);
    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQ, sealed: await seal({ messages: [], register: 'none' }) },
      ctx as any
    );

    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(nicknameEntry('g1', 'bob')).toBeNull();
    expect(isRegisterOwed('me', 'g1')).toBe(true);
    // The fifth unanswered ask was given back: the bound is not spent.
    expect(endSpentRegisterAsks('me', 'g1')).toBe(false);
  });

  it('a decline from EVERY other device of the tree ends the asking - none holds a register', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tree = vi.fn(async () => ['me:device-me', 'ann:a1']);
    const seal = await ask(true);
    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQ, sealed: await seal({ messages: [], register: 'none' }) },
      makeCtx({
        ...RESPONDER,
        mlsService: { ...RESPONDER.mlsService, getGroupMemberIdentities: tree },
      }) as any
    );

    expect(isRegisterOwed('me', 'g1')).toBe(false);
    expect(registerNeverTaken('me', 'g1')).toBe(true);
    expect(warn.mock.calls.join(' ')).toContain('every other device (1) declined');
  });

  it('a WITHHELD decline ends the asking at info, naming it - an unvouched device is no defect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log');
    const tree = vi.fn(async () => ['me:device-me', 'ann:a1']);
    const seal = await ask(true);
    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQ, sealed: await seal({ messages: [], register: 'withheld' }) },
      makeCtx({
        ...RESPONDER,
        mlsService: { ...RESPONDER.mlsService, getGroupMemberIdentities: tree },
      }) as any
    );

    expect(isRegisterOwed('me', 'g1')).toBe(false);
    expect(registerNeverTaken('me', 'g1')).toBe(true);
    expect(log.mock.calls.join(' ')).toContain('withholding history from this unvouched device');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a decline answering a NON-register ask rules nobody out', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const tree = vi.fn(async () => ['me:device-me', 'ann:a1']);
    const seal = await ask(false);
    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQ, sealed: await seal({ messages: [], register: 'none' }) },
      makeCtx({
        ...RESPONDER,
        mlsService: { ...RESPONDER.mlsService, getGroupMemberIdentities: tree },
      }) as any
    );

    expect(isRegisterOwed('me', 'g1')).toBe(true);
    expect(tree).not.toHaveBeenCalled();
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

  it('an UNSEALED answer claiming to answer a register ask is REFUSED, at error', async () => {
    // Every build at the floor (`1.7.0`) seals its answer to a keyed ask, so one in clear is refused
    // whole - its register and its messages alike (docs/wiki/legacy-compatibility.md history).
    await ask(true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = makeCtx(RESPONDER);
    await handleSystemEvent(
      'history_bundle',
      { to: TO_ME, requestId: REQ, register: true, messages: [], nicknames: NICKNAMES },
      ctx as any
    );

    expect(nicknameEntry('g1', 'bob')).toBeNull();
    expect(isRegisterOwed('me', 'g1')).toBe(true);
    expect(ctx.batchAddMessages).not.toHaveBeenCalled();
    expect(error.mock.calls.join(' ')).toContain('REFUSED an unsealed history_bundle');
    error.mockRestore();
  });

  it('takes NOTHING but the register from it - no floor, no read marks, whatever it carries', async () => {
    // Any member can answer a register ask (the key rides the ask): a floor taken from one would
    // let that member hide history from this device for good.
    const seal = await ask(true);
    const ctx = makeCtx(RESPONDER);
    await handleSystemEvent(
      'history_bundle',
      {
        to: TO_ME,
        requestId: REQ,
        sealed: await seal({
          messages: [],
          register: true,
          nicknames: NICKNAMES,
          floor: 900_000,
          readWatermarks: { ann: 999 },
        }),
      },
      ctx as any
    );

    expect(nicknameEntry('g1', 'bob')?.nickname).toBe('Capitaine');
    expect(ctx.conversations.get('g1').historyFloor).toBeUndefined();
    expect(ctx.conversations.get('g1').readWatermarks).toEqual({});
  });

  it('keeps the register owed when the roster could not be read - nothing was taken', async () => {
    const seal = await ask(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleSystemEvent(
      'history_bundle',
      {
        to: TO_ME,
        requestId: REQ,
        sealed: await seal({ messages: [], register: true, nicknames: NICKNAMES }),
      },
      makeCtx({
        ...RESPONDER,
        mlsService: {
          ...RESPONDER.mlsService,
          getGroupMemberIdentities: vi.fn(async () => {
            throw new Error('tree unreadable');
          }),
        },
      }) as any
    );

    expect(nicknameEntry('g1', 'bob')).toBeNull();
    expect(isRegisterOwed('me', 'g1')).toBe(true);
    expect(warn.mock.calls.join(' ')).toContain('the register is still owed');
  });

  it('keeps the register owed when a join push finds no conversation row to merge into', async () => {
    noteJoinSolicited('g1', 'inviter', 1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx({
      ...RESPONDER,
      senderNorm: 'inviter',
      deliveryMeta: { ...RESPONDER.deliveryMeta, senderDeviceId: 'inviter-device' },
    });
    ctx.conversations.delete('g1');
    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: TO_ME, join: true, last: true, floor: 900_000 },
      ctx as any
    );

    expect(isRegisterOwed('me', 'g1')).toBe(true);
  });

  it('keeps the register owed when the merged state of a join push could not be saved', async () => {
    noteJoinSolicited('g1', 'inviter', 1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = makeCtx({
      ...RESPONDER,
      senderNorm: 'inviter',
      deliveryMeta: { ...RESPONDER.deliveryMeta, senderDeviceId: 'inviter-device' },
      saveConversation: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    await handleSystemEvent(
      'history_bundle',
      { messages: [], to: TO_ME, join: true, last: true, floor: 900_000 },
      ctx as any
    );

    expect(isRegisterOwed('me', 'g1')).toBe(true);
  });

  it("the inviter's join push, accepted, clears the marker too", async () => {
    noteJoinSolicited('g1', 'inviter', 1);
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
