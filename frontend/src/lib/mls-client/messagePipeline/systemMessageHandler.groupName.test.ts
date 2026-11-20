import { afterEach, describe, expect, it, vi } from 'vitest';

// Resolve names offline: identity function so the handler runs without the user store / network.
vi.mock('$lib/utils/users/displayName', () => ({
  resolveDisplayNames: vi.fn(async () => (id: string) => id),
}));

import { handleSystemEvent } from './systemMessageHandler';
import { decodeAppMessage } from '$lib/proto/codec';

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

  it("an older build's rename frame (no signed sentAt) is refused and does not move a stated name", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const p = phone();
    await p.state('Groupe', T);
    await p.rename('Ancien build', T + 60_000, 0);
    expect(p.conversations.get('g1').name).toBe('Groupe');
  });
});

/**
 * #3888 review, S1: A SPLIT A STATEMENT REVEALS IS ANSWERED, AND THE ANSWERS TERMINATE. A device
 * holding a RENAME-dated name that reads a statement of another name answers once with a statement of
 * its own name; devices holding statement-dated names take the later statement; an answer is never
 * answered and a statement-dated device never answers, so it ends.
 */
describe('a statement outranked by a rename-dated name of another text is answered', () => {
  afterEach(() => vi.restoreAllMocks());

  type Frame = { name: string; answers?: string };

  /** One member device holding `held`; `sent` collects the statements it answers with. */
  function member(held: { name: string; nameAt?: number; nameFromStatement?: true }) {
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
    const mlsService = {
      whenGroupDrained: vi.fn().mockResolvedValue(undefined),
      persistCheckpoint: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(async (_g: string, bytes: Uint8Array) => {
        sent.push(JSON.parse(decodeAppMessage(bytes)?.system?.data ?? '{}'));
        return { receivedAt: Date.now() };
      }),
    };
    const read = (frame: Frame, id: string, serverAt: number) =>
      handleSystemEvent('groupNamed', frame, {
        mlsService,
        storage: {},
        userId: 'me',
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
        senderNorm: 'peer',
        messageId: id,
        sentAt: serverAt,
        deliveryMeta: { queuedCreatedAt: serverAt },
      } as never);
    const name = () => conversations.get('g1').name as string;
    return { read, sent, name, row: () => conversations.get('g1') };
  }

  /** Lets every chained answer run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('two devices: the rename holder answers once; the statement holder converges; a re-delivery answers nothing', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const renamed = member({ name: 'Nouveau', nameAt: T });
    const stated = member({ name: 'Ancien', nameAt: T + 1_000, nameFromStatement: true });
    await renamed.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    expect(renamed.sent).toEqual([{ name: 'Nouveau', answers: 's-1' }]);
    expect(renamed.name()).toBe('Nouveau');
    expect(renamed.row().nameSync).toEqual({ answered: 's-1' });
    // The answer reaches the statement holder: a later statement, taken.
    await stated.read(renamed.sent[0], 'a-1', T + 2_000);
    expect(stated.name()).toBe('Nouveau');
    await settle();
    expect(stated.sent).toEqual([]);
    // TERMINATION: the same statement again answers nothing.
    await renamed.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    expect(renamed.sent).toHaveLength(1);
  });

  it('three devices, two rename holders whose answers CROSS: every statement holder converges, and nobody answers an answer', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const x = member({ name: 'Nouveau', nameAt: T });
    const z = member({ name: 'Autre', nameAt: T + 10 });
    await x.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await z.read({ name: 'Ancien' }, 's-1', T + 1_000);
    await settle();
    const ax = x.sent[0];
    const az = z.sent[0];
    expect(ax).toEqual({ name: 'Nouveau', answers: 's-1' });
    expect(az).toEqual({ name: 'Autre', answers: 's-1' });
    // Two statement holders read the two answers in opposite orders: the later one wins on both.
    const y1 = member({ name: 'Ancien', nameAt: T + 1_000, nameFromStatement: true });
    const y2 = member({ name: 'Ancien', nameAt: T + 1_000, nameFromStatement: true });
    await y1.read(ax, 'a-x', T + 2_000);
    await y1.read(az, 'a-z', T + 3_000);
    await y2.read(az, 'a-z', T + 3_000);
    await y2.read(ax, 'a-x', T + 2_000);
    expect(y1.name()).toBe('Autre');
    expect(y2.name()).toBe('Autre');
    // Each rename holder reads the other's answer: an answer is never answered - it ends here.
    await x.read(az, 'a-z', T + 3_000);
    await z.read(ax, 'a-x', T + 2_000);
    await settle();
    expect(x.sent).toHaveLength(1);
    expect(z.sent).toHaveLength(1);
    expect([y1.sent, y2.sent]).toEqual([[], []]);
  });
});
