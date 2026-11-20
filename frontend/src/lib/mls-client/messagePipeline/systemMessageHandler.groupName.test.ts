import { afterEach, describe, expect, it, vi } from 'vitest';

// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';
import { decodeAppMessage } from '$lib/proto/codec';
import { noticeContent } from '$lib/utils/chat/visibleNotices';
import { BUNDLE_SERVER_TIME_SKEW_MS } from '$lib/utils/chat/messageTime';

/**
 * A GROUP'S NAME IS THE NEWEST ONE ITS MEMBERS STATED, NOT THE LAST ONE THIS DEVICE READ.
 *
 * Every `groupRenamed` frame used to be applied as it arrived, so a device that read an older rename
 * after a newer one - a queue drain behind a live frame, a replay page behind both - put the older
 * name back, and only the server's list could correct it. That list is going away
 * (docs/wiki/protocols/sealed-names.md), so the frames must settle it alone: by the server's
 * acceptance time of the frame that stated each name (`groupName.ts`).
 */

const T = Date.UTC(2026, 10, 17, 9, 0, 0);

function device(conversationType: 'group' | 'direct' = 'group') {
  const convo = {
    id: 'g1',
    contactName: 'g1',
    lifecycle: 'active',
    messages: [],
    name: 'Groupe',
    conversationType,
  };
  const conversations = new Map<string, any>([['g1', convo]]);
  const saveConversation = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    mlsService: {},
    storage: {},
    userId: 'me',
    deviceKey: () => 'device-key',
    conversations,
    messageReactions: new Map(),
    addMessageToChat: vi.fn().mockResolvedValue(undefined),
    batchAddMessages: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    saveConversation,
    getSelectedContact: () => 'g1',
    setSelectedContact: vi.fn(),
    onReadStateAdvanced: vi.fn(),
    log: vi.fn(),
    convoKey: 'g1',
    persistMlsStateNow: vi.fn(),
  };
  const rename = (newName: string, serverAt: number | undefined, sentAt: number = serverAt ?? T) =>
    handleSystemEvent('groupRenamed', { newName }, {
      ...ctx,
      convo: conversations.get('g1'),
      senderNorm: 'alice',
      messageId: crypto.randomUUID(),
      sentAt,
      deliveryMeta: serverAt === undefined ? undefined : { queuedCreatedAt: serverAt },
    } as never);
  return { conversations, saveConversation, rename };
}

describe('a received groupRenamed frame', () => {
  afterEach(() => vi.restoreAllMocks());

  it('an OLDER rename read after a newer one does not put the older name back', async () => {
    const phone = device();
    await phone.rename('Les ROOTz', T + 60_000);
    await phone.rename('Ancien nom', T);
    expect(phone.conversations.get('g1').name).toBe('Les ROOTz');
    expect(phone.conversations.get('g1').nameAt).toBe(T + 60_000);
  });

  it('dates the name it applies, and saves the row that carries both', async () => {
    const phone = device();
    await phone.rename('Les ROOTz', T);
    expect(phone.conversations.get('g1')).toMatchObject({ name: 'Les ROOTz', nameAt: T });
    expect(phone.saveConversation).toHaveBeenCalledWith('g1');
  });

  it('a frame with no server time names nothing, and says why at ERROR', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phone = device();
    await phone.rename('Les ROOTz', undefined);
    expect(phone.conversations.get('g1').name).toBe('Groupe');
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'carries no server time'
    );
  });

  it('a server time far from the signed sentAt is refused at ERROR: a hostile stamp locks nothing in', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phone = device();
    await phone.rename('Pour toujours', Date.UTC(2100, 0, 1), T);
    expect(phone.conversations.get('g1').name).toBe('Groupe');
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('signed sentAt');
  });

  it('an empty name is refused for being empty, not for a missing server time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const phone = device();
    await phone.rename('   ', T);
    const said = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('empty once trimmed');
    expect(said).not.toContain('server time');
  });

  it('a rename inside a DM names its true cause, not "not newer"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const phone = device('direct');
    await phone.rename('Les ROOTz', T);
    expect(phone.conversations.get('g1').name).toBe('Groupe');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('not a group');
  });
});

/**
 * A SILENT `groupNamed` STATEMENT (sealed-names.md, step 2): a creation, or the one-time restatement
 * of a group that existed before names were dated. It dates the name and draws no notice; two that
 * cross settle by the tie rule; a rename beats one whatever the dates, so a restatement crossing a
 * real rename never puts the old name back - in either reading order.
 */
describe('a received groupNamed statement', () => {
  afterEach(() => vi.restoreAllMocks());

  function phone() {
    const d = device();
    const ctx = (serverAt: number, sentAt = serverAt) => ({
      convo: d.conversations.get('g1'),
      senderNorm: 'bob',
      messageId: crypto.randomUUID(),
      sentAt,
      deliveryMeta: { queuedCreatedAt: serverAt },
    });
    const addMessageToChat = vi.fn().mockResolvedValue(undefined);
    const state = (name: string, serverAt: number) =>
      handleSystemEvent('groupNamed', { name }, {
        ...base(d, addMessageToChat),
        ...ctx(serverAt),
      } as never);
    return { ...d, state, addMessageToChat };
  }

  /** The handler context `device()` built, with this test's notice writer. */
  function base(d: ReturnType<typeof device>, addMessageToChat: ReturnType<typeof vi.fn>) {
    return {
      // A rename-dated row answers an outranked statement once the group drains - never, here.
      mlsService: { whenGroupDrained: () => new Promise(() => {}) },
      storage: {},
      userId: 'me',
      deviceKey: () => 'device-key',
      conversations: d.conversations,
      messageReactions: new Map(),
      addMessageToChat,
      batchAddMessages: vi.fn(),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      saveConversation: d.saveConversation,
      getSelectedContact: () => 'g1',
      setSelectedContact: vi.fn(),
      onReadStateAdvanced: vi.fn(),
      log: vi.fn(),
      convoKey: 'g1',
      persistMlsStateNow: vi.fn(),
    };
  }

  it('dates the name at a statement rank, saves it, and draws NO notice', async () => {
    const p = phone();
    await p.state('Groupe', T);
    expect(p.conversations.get('g1')).toMatchObject({
      name: 'Groupe',
      nameAt: T,
      nameFromStatement: true,
    });
    expect(p.saveConversation).toHaveBeenCalledWith('g1');
    expect(p.addMessageToChat).not.toHaveBeenCalled();
  });

  it('two crossing restatements converge, whatever order a device reads them in', async () => {
    const a = phone();
    await a.state('Les ROOTz', T);
    await a.state('Groupe', T + 1_000);
    const b = phone();
    await b.state('Groupe', T + 1_000);
    await b.state('Les ROOTz', T);
    expect(a.conversations.get('g1').name).toBe('Groupe');
    expect(b.conversations.get('g1').name).toBe('Groupe');
    // A tie goes to the larger name, read in either order.
    const c = phone();
    await c.state('Alpha', T);
    await c.state('Zeta', T);
    const d = phone();
    await d.state('Zeta', T);
    await d.state('Alpha', T);
    expect(c.conversations.get('g1').name).toBe('Zeta');
    expect(d.conversations.get('g1').name).toBe('Zeta');
  });

  it('a restatement LATER than a crossing rename never puts the old name back, in either order', async () => {
    const first = phone();
    await first.rename('Nouveau', T);
    await first.state('Groupe', T + 1_000);
    const second = phone();
    await second.state('Groupe', T + 1_000);
    await second.rename('Nouveau', T);
    for (const p of [first, second]) {
      expect(p.conversations.get('g1').name).toBe('Nouveau');
      expect(p.conversations.get('g1').nameFromStatement).toBeUndefined();
    }
  });

  it('a statement that CHANGES the name shown draws a notice naming its MLS sender; one that only dates it draws none', async () => {
    const p = phone();
    await p.state('Groupe', T);
    expect(p.addMessageToChat).not.toHaveBeenCalled();
    await p.state('Pirate', T + 1_000);
    expect(p.conversations.get('g1').name).toBe('Pirate');
    expect(p.addMessageToChat).toHaveBeenCalledTimes(1);
    const [sender, content] = p.addMessageToChat.mock.calls[0];
    expect(sender).toBe('system');
    expect(JSON.parse(content).notice).toEqual({
      event: 'groupRenamed',
      actor: 'bob',
      name: 'Pirate',
    });
  });

  it("an undated LIST name or an EMPTY one changed by a statement is noticed; an invitee's placeholder replaced is not (2026-11-20)", async () => {
    // During the rollout every row is undated: a forger stating a new name over the list's is seen.
    const listed = phone();
    await listed.state('Autre', T);
    expect(listed.conversations.get('g1').name).toBe('Autre');
    expect(listed.addMessageToChat).toHaveBeenCalledTimes(1);
    // An unnamed group stays undated: naming it is a change too.
    const unnamed = phone();
    unnamed.conversations.set('g1', { ...unnamed.conversations.get('g1'), name: '' });
    await unnamed.state('Pirate', T);
    expect(unnamed.addMessageToChat).toHaveBeenCalledTimes(1);
    // The honest rollout restates the name shown: nothing changes, nothing is drawn.
    const honest = phone();
    await honest.state('Groupe', T);
    expect(honest.addMessageToChat).not.toHaveBeenCalled();
    // What the Welcome writes - the group's own id, undated - and a raw id are placeholders: silent.
    for (const placeholder of ['g1', '3f2b8c1e-0d4a-4c7e-9b1f-2a6d5e8c7b90']) {
      const p = phone();
      p.conversations.set('g1', { ...p.conversations.get('g1'), name: placeholder });
      await p.state('Nouveau', T);
      expect(p.conversations.get('g1').name).toBe('Nouveau');
      expect(p.addMessageToChat).not.toHaveBeenCalled();
      await p.state('Pirate', T + 1_000);
      expect(p.addMessageToChat).toHaveBeenCalledTimes(1);
    }
  });

  it("an older build's rename frame (no signed sentAt) is refused and does not move a stated name", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const p = phone();
    await p.state('Groupe', T);
    await p.rename('Ancien build', T + 60_000, 0);
    expect(p.conversations.get('g1').name).toBe('Groupe');
  });
});

/**
 * #3888 review S1, re-review A1-A3: A SPLIT A STATEMENT REVEALS IS ANSWERED, AND THE ANSWERS
 * TERMINATE. Only the devices of the user whose RENAME dated the name answer (A2), with a statement of
 * that name carrying the rename's date (A3), owed on the row until sent (A1). Devices holding
 * statement-dated names take the answer over any plain statement and order answers by their rename;
 * an answer is never answered and a statement-dated device never answers, so it ends.
 */
describe('a statement outranked by a rename-dated name of another text is answered', () => {
  afterEach(() => vi.restoreAllMocks());

  type Frame = { name: string; answers?: string; renameAt?: number };

  /** One member device of `userId` holding `held`; `sent` collects the answers it sends. */
  function member(
    held: { name: string; nameAt?: number; nameFromStatement?: true; nameRenamedBy?: string },
    userId = 'me',
    storage: object = {}
  ) {
    const conversations = new Map<string, any>([
      [
        'g1',
        {
          id: 'g1',
          contactName: 'g1',
          lifecycle: 'active',
          messages: [],
          conversationType: 'group',
          ...held,
        },
      ],
    ]);
    const sent: Frame[] = [];
    // Undrained while a frame of the group is being handled; the drain then runs the owed answer.
    let drained = false;
    const mlsService = {
      isGroupDrained: () => drained,
      whenGroupDrained: vi.fn(async () => {
        drained = true;
      }),
      getGroupServerStatus: vi.fn(async () => ({
        groupId: 'g1',
        name: '',
        isGroup: true,
        deletedAt: null,
        serverNow: Date.now(),
      })),
      persistCheckpoint: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(async (_g: string, bytes: Uint8Array) => {
        sent.push(JSON.parse(decodeAppMessage(bytes)?.system?.data ?? '{}'));
        return { receivedAt: Date.now() };
      }),
    };
    const read = (frame: Frame, id: string, serverAt: number, sender = 'peer') => {
      drained = false;
      return handleSystemEvent('groupNamed', frame, {
        mlsService,
        storage,
        userId,
        deviceKey: () => 'device-key',
        conversations,
        messageReactions: new Map(),
        addMessageToChat: vi.fn().mockResolvedValue(undefined),
        batchAddMessages: vi.fn(),
        deleteConversation: vi.fn().mockResolvedValue(undefined),
        saveConversation: vi.fn().mockResolvedValue(undefined),
        getSelectedContact: () => 'g1',
        setSelectedContact: vi.fn(),
        onReadStateAdvanced: vi.fn(),
        log: vi.fn(),
        convoKey: 'g1',
        persistMlsStateNow: vi.fn(),
        convo: conversations.get('g1'),
        senderNorm: sender,
        messageId: id,
        sentAt: serverAt,
        deliveryMeta: { queuedCreatedAt: serverAt },
      } as never);
    };
    const name = () => conversations.get('g1').name as string;
    return { read, sent, name, row: () => conversations.get('g1') };
  }

  /** Lets every chained answer run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const quiet = () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  };

  it("two devices: the rename's author answers once; the statement holder converges; a re-delivery answers nothing", async () => {
    quiet();
    const renamed = member({ name: 'Nouveau', nameAt: T, nameRenamedBy: 'me' });
    const stated = member({ name: 'Ancien', nameAt: T + 1_000, nameFromStatement: true }, 'bob');
    await renamed.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    expect(renamed.sent).toEqual([{ name: 'Nouveau', answers: 's-1', renameAt: T }]);
    expect(renamed.name()).toBe('Nouveau');
    expect(renamed.row().nameSync).toEqual({ answer: { to: 's-1', done: true } });
    // The answer reaches the statement holder: it outranks the plain statement, taken.
    await stated.read(renamed.sent[0], 'a-1', T + 2_000, 'me');
    expect(stated.row()).toMatchObject({ name: 'Nouveau', nameRenameAt: T });
    await settle();
    expect(stated.sent).toEqual([]);
    // TERMINATION: the same statement again answers nothing.
    await renamed.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    expect(renamed.sent).toHaveLength(1);
  });

  it("A2: N devices of OTHER users holding the same rename send nothing; the author's devices do, and a late one skips after reading the first answer", async () => {
    quiet();
    const held = { name: 'Nouveau', nameAt: T, nameRenamedBy: 'alice' };
    const others = ['bob', 'carol', 'dave', 'erin'].map((u) => member(held, u));
    for (const o of others) await o.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    expect(others.map((o) => o.sent)).toEqual([[], [], [], []]);
    expect(others.map((o) => o.row().nameSync)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // Two devices of the author: the first answers; the second read the statement, then - in the
    // same drain - the first one's answer, and skips its own.
    const phone = member(held, 'alice');
    const laptop = member(held, 'alice');
    await phone.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    expect(phone.sent).toEqual([{ name: 'Nouveau', answers: 's-1', renameAt: T }]);
    await laptop.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await laptop.read(phone.sent[0], 'a-1', T + 2_000, 'alice');
    await settle();
    expect(laptop.sent).toEqual([]);
    expect(laptop.row().nameSync).toEqual({ answer: { to: 's-1', done: true } });
  });

  it('A3: three devices, answers of two renames CROSS - every statement holder takes the NEWER rename in both orders, and nobody answers an answer', async () => {
    quiet();
    // x's rename (T) is older than z's (T + 10); x's answer is SENT later.
    const x = member({ name: 'Nouveau', nameAt: T, nameRenamedBy: 'xavier' }, 'xavier');
    const z = member({ name: 'Autre', nameAt: T + 10, nameRenamedBy: 'zoe' }, 'zoe');
    await z.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    await x.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    const [az] = z.sent;
    const [ax] = x.sent;
    expect(ax).toEqual({ name: 'Nouveau', answers: 's-1', renameAt: T });
    expect(az).toEqual({ name: 'Autre', answers: 's-1', renameAt: T + 10 });
    const y1 = member({ name: 'Ancien', nameAt: T + 1_000, nameFromStatement: true }, 'y');
    const y2 = member({ name: 'Ancien', nameAt: T + 1_000, nameFromStatement: true }, 'y');
    await y1.read(az, 'a-z', T + 2_000, 'zoe');
    await y1.read(ax, 'a-x', T + 3_000, 'xavier');
    await y2.read(ax, 'a-x', T + 3_000, 'xavier');
    await y2.read(az, 'a-z', T + 2_000, 'zoe');
    expect(y1.name()).toBe('Autre');
    expect(y2.name()).toBe('Autre');
    // Each rename holder reads the other's answer: an answer is never answered - it ends here.
    await x.read(az, 'a-z', T + 2_000, 'zoe');
    await z.read(ax, 'a-x', T + 3_000, 'xavier');
    await settle();
    expect(x.sent).toHaveLength(1);
    expect(z.sent).toHaveLength(1);
    expect([y1.sent, y2.sent]).toEqual([[], []]);
  });

  it("a rename dated before its author was stored learns it from this device's own notice, then answers", async () => {
    quiet();
    const notice = {
      content: noticeContent({ event: 'groupRenamed', actor: 'me', name: 'Nouveau' }, (id) => id),
      serverTimestamp: T,
    };
    const getMessagesSince = vi.fn().mockResolvedValue([
      {
        content: noticeContent(
          { event: 'groupRenamed', actor: 'other', name: 'Vieux' },
          (id) => id
        ),
        serverTimestamp: T - 9,
      },
      notice,
    ]);
    const old = member({ name: 'Nouveau', nameAt: T }, 'me', { getMessagesSince });
    await old.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    // BOUNDED: the two days around the rename, whatever the conversation's size.
    expect(getMessagesSince).toHaveBeenCalledWith(
      'g1',
      T - BUNDLE_SERVER_TIME_SKEW_MS,
      'device-key',
      T + BUNDLE_SERVER_TIME_SKEW_MS
    );
    expect(old.row().nameRenamedBy).toBe('me');
    expect(old.sent).toEqual([{ name: 'Nouveau', answers: 's-1', renameAt: T }]);
    // No notice of that rename on this device: the field stays empty, nobody answers, and it is said.
    const empty = vi.fn().mockResolvedValue([]);
    const none = member({ name: 'Nouveau', nameAt: T + 7 }, 'me', { getMessagesSince: empty });
    await none.read({ name: 'Ancien' }, 's-2', T + 1_000);
    await settle();
    expect(none.row().nameRenamedBy).toBeUndefined();
    expect(none.sent).toEqual([]);
    // Searched once per rename: a later statement does not decrypt the window again.
    await none.read({ name: 'Autre' }, 's-3', T + 2_000);
    expect(empty).toHaveBeenCalledTimes(1);
    // A notice of the SAME name at ANOTHER time is another rename: it names no author for this one.
    const elsewhen = member({ name: 'Nouveau', nameAt: T + 8 }, 'me', {
      getMessagesSince: vi.fn().mockResolvedValue([{ ...notice, serverTimestamp: T + 9 }]),
    });
    await elsewhen.read({ name: 'Ancien' }, 's-4', T + 1_000);
    await settle();
    expect(elsewhen.row().nameRenamedBy).toBeUndefined();
    expect(elsewhen.sent).toEqual([]);
    expect(
      (console.info as any).mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    ).toContain('rename author of g1');
  });

  it('an answer whose rename date lies after its own server time is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    quiet();
    const y = member({ name: 'Ancien', nameAt: T, nameFromStatement: true }, 'y');
    await y.read(
      { name: 'Faux', answers: 's-1', renameAt: T + 5_000 },
      'a-1',
      T + 1_000,
      'mallory'
    );
    expect(y.name()).toBe('Ancien');
    expect(
      [
        ...warn.mock.calls,
        ...(console.error as any).mock.calls,
        ...(console.info as any).mock.calls,
      ]
        .map((c) => String(c[0]))
        .join('\n')
    ).toContain('rename date');
  });
});
