// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceEvent } from '$lib/mls-client/deviceTrust';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  resetReportedUninvitedEntries,
  setUninvitedEntryReporter,
} from '$lib/mls-client/uninvitedEntry';
import {
  deliverDeviceEvents,
  dismissDeviceNotice,
  dismissRefusedDeviceNotice,
  forgetDeviceNotices,
  loadDeviceNotices,
  noteRefusedOwnDevices,
  pendingDeviceNotices,
  pendingRefusedDeviceNotices,
  type DeviceNoticeContext,
  type KeyAge,
} from './deviceNotices.svelte';
import {
  MAX_HISTORY_WITHHELD,
  bindHistoryWithheld,
  historySealedGroups,
  historyWithheldEntries,
  historyWithheldFrom,
  noteDeviceAddedByAMember,
  sealHistoryIn,
} from './historyWithheld';

/**
 * User decision 2026-10-22: the owner is alerted (in the app, durably until seen) when a device
 * joins the account; a contact's new device is a discreet line in a DM or group - never in a
 * community or its key groups. A `pinned` re-add (resync, heal, kick and re-add under the same key)
 * and an audience `none` event produce nothing (#2268 review).
 */
const event = (over: Partial<DeviceEvent> = {}): DeviceEvent => ({
  groupId: 'dm-1',
  epoch: 5,
  identity: 'bob:web-2',
  keyFingerprint: '00ff',
  trust: 'first-sight',
  addedBy: 'bob:phone-1',
  memberAlreadyPresent: true,
  ...over,
});

/**
 * Alice's conversations: a DM and a group with bob, a group without him, a salon row and a
 * community key group he is in, and a DM with carol.
 */
const TREES: Record<string, string[]> = {
  'dm-1': ['alice:phone-a', 'bob:phone-1'],
  'group-1': ['alice:phone-a', 'bob:phone-1', 'carol:p'],
  'group-no-bob': ['alice:phone-a', 'carol:p'],
  'salon-1': ['alice:phone-a', 'bob:phone-1'],
  'community-key': ['alice:phone-a', 'BOB:phone-1'],
  'dm-carol': ['alice:phone-a', 'carol:p'],
};

/**
 * The conversation rows in the DURABLE store: a key group never has one (it is joined by external
 * commit and its frames never reach the conversation pipeline), nor does a salon's MLS-less row here.
 */
const STORED_ROWS: Record<string, { lifecycle: 'active' | 'pending' | 'removed' }> = {
  'dm-1': { lifecycle: 'active' },
  'group-1': { lifecycle: 'active' },
  'group-no-bob': { lifecycle: 'active' },
  'dm-carol': { lifecycle: 'active' },
};

/** What the store holds for the bound account after a delivery. */
const storedNotices = () =>
  JSON.parse(localStorage.getItem(ACCOUNT_KEY.deviceNotices('alice')) ?? '{}') as {
    lined?: string[];
    owedLines?: unknown[];
  };

const DAY = 24 * 3600_000;
const NOW = 100 * DAY;
/** This device enrolled ten days ago. */
const ENROLLED = 90 * DAY;

function makeCtx(over: Partial<DeviceNoticeContext> = {}) {
  const conversations = new Map<
    string,
    { conversationType?: string; directPeerId?: string; messages: { id: string }[] }
  >([
    ['dm-1', { conversationType: 'direct', directPeerId: 'bob', messages: [] }],
    ['group-1', { conversationType: 'group', messages: [] }],
    ['group-no-bob', { conversationType: 'group', messages: [] }],
    ['salon-1', { conversationType: 'channel', messages: [] }],
    ['community-key', { conversationType: 'group', messages: [] }],
    ['dm-carol', { conversationType: 'direct', directPeerId: 'Carol', messages: [] }],
  ]);
  const addMessageToChat = vi.fn(
    async (_s: string, _c: string, convoKey: string, options?: { messageId?: string }) => {
      conversations.get(convoKey)?.messages.push({ id: options?.messageId ?? 'x' });
    }
  );
  const ctx: DeviceNoticeContext = {
    ownUserId: 'alice',
    ownDeviceId: 'phone-a',
    isDistributionGroup: (g) => g === 'community-key',
    conversations,
    localGroups: () => Object.keys(TREES),
    heldGroupsKnown: () => true,
    storedConversation: async (g) => STORED_ROWS[g] ?? null,
    memberIdentities: vi.fn(async (g: string) => {
      const tree = TREES[g];
      if (!tree) throw new Error(`group ${g} not held`);
      return tree;
    }),
    // By default this device saw nobody leave any tree.
    removalEpochs: vi.fn(async (): Promise<number[]> => []),
    addMessageToChat,
    resolveDisplayNames: async () => (id: string) => (id === 'bob' ? 'Bob' : id),
    deviceLabel: async () => undefined,
    // By default every key was first seen by the server five minutes ago - a NEW device.
    keyAge: vi.fn(async (): Promise<KeyAge> => ({ kind: 'dated', at: NOW - 5 * 60_000 })),
    ownEnrolledAt: async () => ENROLLED,
    claimNative: vi.fn(async () => {}),
    now: () => NOW,
    ...over,
  };
  return { ctx, addMessageToChat, conversations };
}

beforeEach(() => {
  localStorage.clear();
  forgetDeviceNotices();
  loadDeviceNotices('alice');
});
afterEach(() => forgetDeviceNotices());

/** The conversations a contact line was written in, in call order. */
const linesWrittenIn = (calls: unknown[][]) => calls.map((c) => c[2]);

describe('deliverDeviceEvents - the contact line', () => {
  it('writes one system line in every DM and group shared with the contact, idempotent', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([event()], ctx);
    await deliverDeviceEvents([event()], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
    const [sender, content, , options] = addMessageToChat.mock.calls[0];
    expect(sender).toBe('system');
    expect(content).toContain('Bob');
    expect(options).toMatchObject({ isSystem: true });
  });

  it('a device first seen in a community still reaches the DM and group shared with its owner', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([event({ groupId: 'community-key' })], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
  });

  it('writes NOTHING in a community key group, a salon, or a conversation without the contact', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([event({ groupId: 'group-1' })], ctx);
    const written = linesWrittenIn(addMessageToChat.mock.calls);
    expect(written).not.toContain('community-key');
    expect(written).not.toContain('salon-1');
    expect(written).not.toContain('group-no-bob');
    expect(written).not.toContain('dm-carol');
  });

  it('a conversation whose tree this device does not hold is skipped, the others still written', async () => {
    const { ctx, addMessageToChat, conversations } = makeCtx();
    conversations.set('dm-gone', { conversationType: 'direct', messages: [] });
    await deliverDeviceEvents([event()], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
  });

  // THE START-UP DRAIN MAY RUN BEFORE THE CONVERSATION ROWS ARE LOADED: a group this device holds
  // with the contact in it but no row yet is a line still OWED, never a device already lined.
  it('owes the line of a held group whose row is not loaded yet, and writes it once it is', async () => {
    const { ctx, addMessageToChat, conversations } = makeCtx();
    const rows = new Map(conversations);
    conversations.clear();
    await deliverDeviceEvents([event()], ctx);
    expect(addMessageToChat).not.toHaveBeenCalled();

    for (const [id, row] of rows) conversations.set(id, row);
    await deliverDeviceEvents([], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
    expect(ctx.keyAge, 'the evidence is asked once, the line retried alone').toHaveBeenCalledTimes(
      1
    );

    await deliverDeviceEvents([], ctx);
    expect(addMessageToChat).toHaveBeenCalledTimes(2);
  });

  it('owes the line while a held tree is unreadable, and survives a reload', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    let broken = true;
    ctx.memberIdentities = vi.fn(async (g: string) => {
      if (broken && g === 'dm-1') throw new Error('state busy');
      return TREES[g];
    });
    await deliverDeviceEvents([event()], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['group-1']);

    forgetDeviceNotices();
    loadDeviceNotices('alice');
    broken = false;
    await deliverDeviceEvents([], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['group-1', 'dm-1']);
  });

  it('drops an owed line once the device is no longer new to the contact window', async () => {
    let now = NOW;
    const { ctx, addMessageToChat, conversations } = makeCtx({ now: () => now });
    conversations.clear();
    await deliverDeviceEvents([event()], ctx);
    now += 8 * DAY;
    conversations.set('dm-1', { conversationType: 'direct', messages: [] });
    await deliverDeviceEvents([], ctx);
    expect(addMessageToChat).not.toHaveBeenCalled();
    // The drop is durable: a reload must not resurrect the line it just expired.
    expect(storedNotices().owedLines).toEqual([]);
  });

  // WHERE A LINE IS OWED IS DECIDED FROM THE DURABLE CONVERSATION ROW, not from a session-local
  // set: at start-up a key group may not be named yet, and a deleted conversation's state may
  // linger in the held groups - neither will ever get a row, so neither may keep a line owed.
  it('owes nothing for a held group with no stored row (unnamed key group) or a removed one', async () => {
    const { ctx, addMessageToChat, conversations } = makeCtx({
      isDistributionGroup: () => false,
      localGroups: () => [...Object.keys(TREES), 'dm-removed'],
      memberIdentities: vi.fn(async (g: string) =>
        g === 'dm-removed' ? ['alice:phone-a', 'bob:phone-1'] : TREES[g]
      ),
      storedConversation: async (g) =>
        g === 'dm-removed' ? { lifecycle: 'removed' } : (STORED_ROWS[g] ?? null),
    });
    conversations.delete('community-key');
    await deliverDeviceEvents([event()], ctx);
    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-1', 'group-1']);
    expect(storedNotices().owedLines).toEqual([]);
    expect(storedNotices().lined).toHaveLength(1);
  });

  it('warns with the count, never the ids, when the owed lines overflow their bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, conversations } = makeCtx();
    conversations.clear();
    const events = Array.from({ length: 66 }, (_, i) =>
      event({ keyFingerprint: i.toString(16).padStart(4, '0') })
    );
    await deliverDeviceEvents(events, ctx);
    const overflow = warn.mock.calls.map((c) => String(c[0])).filter((l) => /owed/.test(l));
    expect(overflow).toHaveLength(2);
    expect(overflow[0]).toMatch(/1 owed contact line/);
    for (const line of overflow) expect(line).not.toMatch(/bob|web-2/);
    expect(storedNotices().owedLines).toHaveLength(64);
    warn.mockRestore();
  });

  it('writes nothing for a pinned re-add, a member joining, or a joined-tree key change', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents(
      [
        event({ trust: 'pinned' }),
        event({ memberAlreadyPresent: false }),
        event({ trust: 'key-changed', addedBy: null }),
      ],
      ctx
    );
    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(pendingDeviceNotices()).toEqual([]);
  });
});

describe('deliverDeviceEvents - the owner alert', () => {
  const own = event({ identity: 'alice:laptop-9', keyFingerprint: 'cc', addedBy: 'bob:phone-1' });

  it('records one durable alert per device and key, from any group, and claims it natively', async () => {
    const { ctx, addMessageToChat } = makeCtx({ deviceLabel: async () => 'Firefox on Linux' });
    await deliverDeviceEvents([own, { ...own, groupId: 'community-key' }], ctx);
    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(pendingDeviceNotices()).toEqual([
      { key: 'alice:laptop-9|cc', deviceId: 'laptop-9', at: NOW, label: 'Firefox on Linux' },
    ]);
    expect(ctx.claimNative).toHaveBeenCalledWith(['alice:laptop-9|cc']);

    // Survives a reload until seen.
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    expect(pendingDeviceNotices()).toHaveLength(1);
  });

  it('is announced once: dismissed, the same device never comes back', async () => {
    const { ctx } = makeCtx();
    await deliverDeviceEvents([own], ctx);
    dismissDeviceNotice('alice:laptop-9|cc');
    await deliverDeviceEvents([own], ctx);
    expect(pendingDeviceNotices()).toEqual([]);
    expect(localStorage.getItem(ACCOUNT_KEY.deviceNotices('alice'))).toContain('laptop-9');
  });

  it('never alerts the added device about itself', async () => {
    const { ctx } = makeCtx({ ownDeviceId: 'laptop-9' });
    await deliverDeviceEvents([own], ctx);
    expect(pendingDeviceNotices()).toEqual([]);
  });

  it('an own device first seen in a community key group alerts the owner and writes no line', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([{ ...own, groupId: 'community-key' }], ctx);
    expect(pendingDeviceNotices()).toHaveLength(1);
    expect(addMessageToChat).not.toHaveBeenCalled();
  });

  it('one failing event costs only itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, addMessageToChat } = makeCtx();
    addMessageToChat.mockRejectedValueOnce(new Error('db'));
    await deliverDeviceEvents([event(), own], ctx);
    expect(pendingDeviceNotices()).toHaveLength(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

/**
 * "First sight by this device" is not "a new device" (#2278 review): a fresh install, a restore or a
 * heal shows OLD devices this device never pinned, and a heal happens daily. The server's first
 * sight of the key is the evidence, used only to suppress (`isNewToItsOwner`).
 */
describe('deliverDeviceEvents - only a device new to its owner is announced', () => {
  const own = event({ identity: 'alice:laptop-9', keyFingerprint: 'cc', addedBy: 'bob:phone-1' });

  it('fresh install joins a group, then a heal re-adds an old device of a contact: no line', async () => {
    const { ctx, addMessageToChat } = makeCtx({
      keyAge: vi.fn(async (): Promise<KeyAge> => ({ kind: 'dated', at: 30 * DAY })),
    });
    await deliverDeviceEvents([event()], ctx);
    expect(addMessageToChat).not.toHaveBeenCalled();
  });

  it("a contact's device the server first saw long after this device enrolled, but weeks ago: no line", async () => {
    const { ctx, addMessageToChat } = makeCtx({
      keyAge: vi.fn(async (): Promise<KeyAge> => ({ kind: 'dated', at: NOW - 8 * DAY })),
    });
    await deliverDeviceEvents([event({ groupId: 'group-1' })], ctx);
    expect(addMessageToChat).not.toHaveBeenCalled();
  });

  it('a key the server history never dated is old: no line, no alert', async () => {
    const { ctx, addMessageToChat } = makeCtx({
      keyAge: vi.fn(async (): Promise<KeyAge> => ({ kind: 'undated' })),
    });
    await deliverDeviceEvents([event(), own], ctx);
    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(pendingDeviceNotices()).toEqual([]);
  });

  it('a real new device: a line, and the key it names is the one dated', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([event()], ctx);
    expect(addMessageToChat).toHaveBeenCalled();
    expect(ctx.keyAge).toHaveBeenCalledWith('bob', 'web-2', '00ff');
  });

  it("the owner's old web device re-added on a young device: no alert", async () => {
    const { ctx } = makeCtx({
      keyAge: vi.fn(async (): Promise<KeyAge> => ({ kind: 'dated', at: ENROLLED - DAY })),
    });
    await deliverDeviceEvents([own], ctx);
    expect(pendingDeviceNotices()).toEqual([]);
  });

  it('an unanswered age keeps the event, and the next delivery decides it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keyAge = vi
      .fn<() => Promise<KeyAge>>()
      .mockResolvedValueOnce({ kind: 'unanswered' })
      .mockResolvedValue({ kind: 'dated', at: NOW - 60_000 });
    const { ctx } = makeCtx({ keyAge });
    await deliverDeviceEvents([own], ctx);
    expect(pendingDeviceNotices()).toEqual([]);

    // Kept across a reload too.
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    await deliverDeviceEvents([], ctx);
    expect(pendingDeviceNotices()).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('deliverDeviceEvents - a contact line is written once, durably', () => {
  it('does not come back when the conversation has not loaded the earlier line', async () => {
    const { ctx, addMessageToChat, conversations } = makeCtx();
    await deliverDeviceEvents([event()], ctx);
    const written = addMessageToChat.mock.calls.length;
    for (const convo of conversations.values()) convo.messages.length = 0;
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    await deliverDeviceEvents([event({ groupId: 'group-1', epoch: 9 })], ctx);
    expect(addMessageToChat).toHaveBeenCalledTimes(written);
  });
});

/**
 * A device of MY account that this device refused for a changed key (`refusedDevices.ts`) cannot be
 * re-added to anything until it is reset - its owner is told so in the app, with the remedy. A
 * contact's refused device is not mine to be told about.
 */
describe('noteRefusedOwnDevices - the refused device of my own', () => {
  const labels = { deviceLabel: async (d: string) => (d === 'old' ? 'Pixel' : undefined) };

  it('tells the owner of an own refused device only, with its name', async () => {
    await noteRefusedOwnDevices(['ALICE:old', 'bob:x'], { ownUserId: 'alice', ...labels });
    expect(pendingRefusedDeviceNotices()).toEqual([
      { identity: 'alice:old', deviceId: 'old', label: 'Pixel' },
    ]);
  });

  it('stays until dismissed, and a dismissed one never comes back', async () => {
    await noteRefusedOwnDevices(['alice:old'], { ownUserId: 'alice', ...labels });
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    await noteRefusedOwnDevices(['alice:old'], { ownUserId: 'alice', ...labels });
    expect(pendingRefusedDeviceNotices()).toHaveLength(1);

    dismissRefusedDeviceNotice('alice:old');
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    await noteRefusedOwnDevices(['alice:old'], { ownUserId: 'alice', ...labels });
    expect(pendingRefusedDeviceNotices()).toEqual([]);
  });
});

// AN ENTRY NO MEMBER MADE: a new person admitted by their own commit (`entersUninvited`). Written in
// the conversation itself and reported to the server once - the measurement the refusal waits on.
// Never in a community key group, where an external commit is how every member enters.
describe('deliverDeviceEvents - an entry no member made', () => {
  const intruder = (over: Partial<DeviceEvent> = {}) =>
    event({
      groupId: 'group-1',
      identity: 'mallory:dev1',
      addedBy: 'mallory:dev1',
      memberAlreadyPresent: false,
      ...over,
    });
  const reporter = vi.fn(async () => {});
  beforeEach(() => {
    reporter.mockClear();
    resetReportedUninvitedEntries();
    setUninvitedEntryReporter(reporter);
  });
  afterEach(() => setUninvitedEntryReporter(null));
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  it('writes a line in the conversation it entered, and reports it once', async () => {
    const error = quiet();
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([intruder()], ctx);
    await deliverDeviceEvents([intruder()], ctx);

    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['group-1']);
    const [sender, content, , options] = addMessageToChat.mock.calls[0];
    expect(sender).toBe('system');
    expect(content).toContain('mallory');
    expect(options).toMatchObject({ isSystem: true });
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith({
      kind: 'new-person',
      groupId: 'group-1',
      entrant: 'mallory:dev1',
      epoch: 5,
      keyFingerprint: '00ff',
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('UNINVITED ENTRY'));
    error.mockRestore();
  });

  it('says nothing for a community key group, where every member enters this way', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([intruder({ groupId: 'community-key' })], ctx);

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).not.toHaveBeenCalled();
  });

  it('says nothing for a new person a member added', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([intruder({ addedBy: 'bob:phone-1' })], ctx);

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).not.toHaveBeenCalled();
  });

  it('says nothing for a group with no conversation row at all', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([intruder({ groupId: 'unnamed-key' })], ctx);

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).not.toHaveBeenCalled();
  });

  it('owes the line of a conversation whose row is not loaded yet, across a reload, and writes it once loaded', async () => {
    const error = quiet();
    const first = makeCtx();
    first.conversations.delete('group-1');
    await deliverDeviceEvents([intruder()], first.ctx);
    expect(first.addMessageToChat).not.toHaveBeenCalled();
    // Not reported yet: what the entry IS (a 1:1 peer's rejoin, say) is read from the row.
    expect(reporter).not.toHaveBeenCalled();

    forgetDeviceNotices();
    loadDeviceNotices('alice');
    const second = makeCtx();
    await deliverDeviceEvents([], second.ctx);

    expect(linesWrittenIn(second.addMessageToChat.mock.calls)).toEqual(['group-1']);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'new-person' }));
    error.mockRestore();
  });

  it('writes nothing for a member this device saw leave, and reports a `returning` entry', async () => {
    const error = quiet();
    const { ctx, addMessageToChat } = makeCtx({
      removalEpochs: vi.fn(async (_g: string, u: string) => (u === 'mallory' ? [3] : [])),
    });
    await deliverDeviceEvents([intruder()], ctx);

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'returning' }));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('a departure AFTER the entering epoch is not a return', async () => {
    const error = quiet();
    const { ctx, addMessageToChat } = makeCtx({ removalEpochs: vi.fn(async () => [7]) });
    await deliverDeviceEvents([intruder()], ctx);

    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['group-1']);
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'new-person' }));
    error.mockRestore();
  });

  it('writes nothing for the other person of a 1:1 conversation, and reports a `direct-peer` entry', async () => {
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents(
      [intruder({ groupId: 'dm-carol', identity: 'carol:p2', addedBy: 'carol:p2' })],
      ctx
    );

    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'direct-peer', groupId: 'dm-carol' })
    );
  });

  it('a third person entering a 1:1 conversation is a new person', async () => {
    const error = quiet();
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([intruder({ groupId: 'dm-carol' })], ctx);

    expect(linesWrittenIn(addMessageToChat.mock.calls)).toEqual(['dm-carol']);
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'new-person' }));
    error.mockRestore();
  });

  it('keeps the entry owed when the departures cannot be read, rather than guessing', async () => {
    const error = quiet();
    // Kept for the next delivery, nothing lost: a warning, not an accusation.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeCtx({
      removalEpochs: vi.fn(async () => {
        throw new Error('state locked');
      }),
    });
    await deliverDeviceEvents([intruder()], first.ctx);
    expect(first.addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('owed to the next delivery'),
      expect.any(Error)
    );
    expect(error).not.toHaveBeenCalled();

    const second = makeCtx({ removalEpochs: vi.fn(async () => [2]) });
    await deliverDeviceEvents([], second.ctx);
    expect(second.addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'returning' }));
    error.mockRestore();
    warn.mockRestore();
  });
});

// A DEVICE OF A MEMBER THAT LET ITSELF INTO A GROUP IT WAS NEVER IN (2026-10-27): its own commit, its
// user already in the tree, no leaf of it here before - whatever its pin says. No member added it, so
// it is written in the conversation and reported under its own kind. A device coming back to this
// group, a member's Add, and this very device's own join say nothing.
describe('deliverDeviceEvents - a member device that entered by itself', () => {
  const selfEntry = (over: Partial<DeviceEvent> = {}) =>
    event({
      groupId: 'group-1',
      identity: 'bob:new-tablet',
      addedBy: 'bob:new-tablet',
      memberAlreadyPresent: true,
      firstInGroup: true,
      trust: 'first-sight',
      keyFingerprint: 'beef',
      ...over,
    });
  const reporter = vi.fn(async () => {});
  beforeEach(() => {
    reporter.mockClear();
    resetReportedUninvitedEntries();
    setUninvitedEntryReporter(reporter);
  });
  afterEach(() => setUninvitedEntryReporter(null));

  it('writes the accusing line, reports kind unvouched-device and logs at ERROR', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, addMessageToChat } = makeCtx();
    await deliverDeviceEvents([selfEntry()], ctx);

    const lines = addMessageToChat.mock.calls.filter(([, , , o]) =>
      String((o as { messageId?: string } | undefined)?.messageId).startsWith('uninvited-entry:')
    );
    expect(lines.map((c) => c[2])).toEqual(['group-1']);
    expect(lines[0][1]).toContain('Bob');
    expect(reporter).toHaveBeenCalledWith({
      kind: 'unvouched-device',
      groupId: 'group-1',
      entrant: 'bob:new-tablet',
      epoch: 5,
      keyFingerprint: 'beef',
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('never-seen device of a member'));
    error.mockRestore();
  });

  it("withholds history from it until a member's Add of it vouches for it", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = makeCtx();
    await deliverDeviceEvents([selfEntry()], ctx);
    expect(historyWithheldFrom('group-1', 'bob:new-tablet')).toBe(true);

    await deliverDeviceEvents([selfEntry({ addedBy: 'alice:phone-a', firstInGroup: false })], ctx);
    expect(historyWithheldFrom('group-1', 'bob:new-tablet')).toBe(false);
    error.mockRestore();
    warn.mockRestore();
  });

  it('what it adds is unvouched too: written, reported, withheld - and re-adding itself through it lifts nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = makeCtx();
    await deliverDeviceEvents([selfEntry()], ctx);
    reporter.mockClear();

    // The sibling Add: an ordinary commit, signed by the withheld device, adding a second one.
    await deliverDeviceEvents(
      [selfEntry({ identity: 'bob:second', addedBy: 'bob:new-tablet', keyFingerprint: 'cafe' })],
      ctx
    );
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unvouched-device', entrant: 'bob:second' })
    );
    expect(historyWithheldFrom('group-1', 'bob:second')).toBe(true);

    // ...which then re-adds the first: still withheld.
    await deliverDeviceEvents(
      [selfEntry({ addedBy: 'bob:second', firstInGroup: false, trust: 'pinned' })],
      ctx
    );
    expect(historyWithheldFrom('group-1', 'bob:new-tablet')).toBe(true);
    error.mockRestore();
    warn.mockRestore();
  });

  it('an entry and the Add it makes, handed over in ONE delivery, are both withheld - in commit order', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = makeCtx();
    // Delivered out of order on purpose: the drain's order is not trusted, the epochs are.
    await deliverDeviceEvents(
      [
        selfEntry({ identity: 'bob:second', addedBy: 'bob:new-tablet', epoch: 6 }),
        selfEntry({ epoch: 5 }),
      ],
      ctx
    );
    expect(historyWithheldFrom('group-1', 'bob:new-tablet')).toBe(true);
    expect(historyWithheldFrom('group-1', 'bob:second')).toBe(true);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unvouched-device', entrant: 'bob:second' })
    );
    error.mockRestore();
    warn.mockRestore();
  });

  it('withholds at first sight even while the conversation row is not loaded, and the line follows the row', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, conversations } = makeCtx({
      storedConversation: async () => ({ lifecycle: 'active' }),
    });
    await deliverDeviceEvents([selfEntry({ groupId: 'group-late' })], ctx);
    await deliverDeviceEvents(
      [selfEntry({ groupId: 'group-late', identity: 'bob:second', addedBy: 'bob:new-tablet' })],
      ctx
    );
    expect(reporter).not.toHaveBeenCalled();
    expect(historyWithheldFrom('group-late', 'bob:new-tablet')).toBe(true);
    expect(historyWithheldFrom('group-late', 'bob:second')).toBe(true);

    conversations.set('group-late', { conversationType: 'group', messages: [] });
    await deliverDeviceEvents([], ctx);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unvouched-device', entrant: 'bob:new-tablet' })
    );
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unvouched-device', entrant: 'bob:second' })
    );
    error.mockRestore();
    warn.mockRestore();
  });

  it('a group whose events the queue dropped is sealed, and the marker announces nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, addMessageToChat } = makeCtx();
    const decided = await deliverDeviceEvents(
      [
        event({
          groupId: 'group-1',
          identity: '',
          keyFingerprint: '',
          addedBy: null,
          eventsDropped: true,
        }),
      ],
      ctx
    );
    expect(decided).toBe(true);
    expect(historyWithheldFrom('group-1', 'alice:phone-b')).toBe(true);
    expect(addMessageToChat).not.toHaveBeenCalled();
    expect(reporter).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('says it decided nothing with no account bound, and seals in that account what it took', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    forgetDeviceNotices();
    const { ctx } = makeCtx();
    expect(await deliverDeviceEvents([selfEntry()], ctx)).toBe(false);
    // The account's next session answers no history there.
    loadDeviceNotices('alice');
    expect(historyWithheldFrom('group-1', 'carol:phone-c')).toBe(true);
    error.mockRestore();
  });

  it('seals what is left of a delivery an account switch overtook, in the account it belongs to', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let switched = false;
    const { ctx } = makeCtx({
      // The switch lands while the first event is being decided (its tree read).
      memberIdentities: vi.fn(async (g: string) => {
        if (!switched) {
          switched = true;
          forgetDeviceNotices();
          loadDeviceNotices('mallory');
        }
        return TREES[g] ?? [];
      }),
    });
    const decided = await deliverDeviceEvents(
      [selfEntry(), selfEntry({ groupId: 'group-no-bob', epoch: 9 })],
      ctx
    );
    expect(decided).toBe(false);
    // Nothing leaked into the account now bound.
    expect(historyWithheldFrom('group-no-bob', 'carol:phone-c')).toBe(false);
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    expect(historyWithheldFrom('group-1', 'carol:phone-c')).toBe(true);
    expect(historyWithheldFrom('group-no-bob', 'carol:phone-c')).toBe(true);
    error.mockRestore();
  });

  it('seals no key group in an account its events reached unbound', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    forgetDeviceNotices();
    const { ctx } = makeCtx();
    await deliverDeviceEvents([selfEntry({ groupId: 'community-key' })], ctx);
    loadDeviceNotices('alice');
    expect(historySealedGroups()).toEqual([]);
    error.mockRestore();
  });

  it('merges the seals another tab wrote into the stored copy instead of erasing them', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Another tab sealed a conversation of alice's after this tab read her stored copy.
    const key = ACCOUNT_KEY.deviceNotices('alice');
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({ ...stored, historySealed: ['group-elsewhere'] }));
    // This tab writes its own seal.
    sealHistoryIn('group-1', 'device events were dropped');

    const written = JSON.parse(localStorage.getItem(key) ?? '{}') as { historySealed?: string[] };
    expect(new Set(written.historySealed)).toEqual(new Set(['group-1', 'group-elsewhere']));
    // And this tab answers by it from now on.
    expect(historyWithheldFrom('group-elsewhere', 'carol:p')).toBe(true);
    error.mockRestore();
    warn.mockRestore();
  });

  it('keeps a record another tab added when this tab writes, and never revives one it lifted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = ACCOUNT_KEY.deviceNotices('alice');
    const write = (historyWithheld: unknown[]) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...stored, historyWithheld }));
    };
    const lifted = { groupId: 'group-1', identity: 'bob:tab', fingerprint: 'aa' };
    write([lifted]);
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    // This tab lifts it: a member's Add vouches for the device.
    noteDeviceAddedByAMember('group-1', 'bob:tab', 'carol:p');
    expect(historyWithheldFrom('group-1', 'bob:tab')).toBe(false);

    // The processing tab, which loaded before the lift, writes its own copy back - with the lifted
    // record, and one it added since this tab loaded.
    const added = { groupId: 'group-1', identity: 'bob:web-2', fingerprint: 'bb' };
    write([lifted, added]);
    // This tab writes for an unrelated reason (a notice dismissed).
    sealHistoryIn('group-no-bob', 'device events were dropped');

    const written = JSON.parse(localStorage.getItem(key) ?? '{}') as {
      historyWithheld?: { identity: string }[];
    };
    expect(written.historyWithheld?.map((e) => e.identity)).toEqual(['bob:web-2']);
    expect(historyWithheldFrom('group-1', 'bob:web-2')).toBe(true);
    expect(historyWithheldFrom('group-1', 'bob:tab')).toBe(false);
    warn.mockRestore();
  });

  it('seals no key group on a dropped-events marker - it answers no history anyway', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { ctx } = makeCtx();
    await deliverDeviceEvents(
      [
        event({
          groupId: 'community-key',
          identity: '',
          keyFingerprint: '',
          addedBy: null,
          eventsDropped: true,
        }),
      ],
      ctx
    );
    expect(historySealedGroups()).toEqual([]);
    debug.mockRestore();
  });

  it.each([
    [false, MAX_HISTORY_WITHHELD + 1],
    [true, MAX_HISTORY_WITHHELD],
  ])(
    'past the bound, a group absent from the held list is dropped only when the list is known (%s)',
    async (known, kept) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      bindHistoryWithheld(
        Array.from({ length: MAX_HISTORY_WITHHELD }, (_, i) => ({
          groupId: 'group-gone',
          identity: `x:d${i}`,
          fingerprint: 'f',
        })),
        null
      );
      const { ctx } = makeCtx({ localGroups: () => ['group-1'], heldGroupsKnown: () => known });
      await deliverDeviceEvents([selfEntry()], ctx);
      expect(historyWithheldEntries()).toHaveLength(kept);
      warn.mockRestore();
      error.mockRestore();
    }
  );

  it('withholds history from a device that changed its own key by its own commit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = makeCtx();
    await deliverDeviceEvents(
      [
        selfEntry({
          trust: 'key-changed',
          firstInGroup: false,
          identity: 'bob:phone-1',
          addedBy: 'bob:phone-1',
        }),
      ],
      ctx
    );
    expect(historyWithheldFrom('group-1', 'bob:phone-1')).toBe(true);
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  it('says it in a 1:1 too - the peer of a DM is a member like any other', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx } = makeCtx();
    await deliverDeviceEvents([selfEntry({ groupId: 'dm-1' })], ctx);

    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unvouched-device' }));
    error.mockRestore();
  });

  it('reports a device pinned by ANOTHER group entering this one by itself - the pin vouches for nothing here', async () => {
    const { ctx } = makeCtx();
    await deliverDeviceEvents([selfEntry({ trust: 'pinned' })], ctx);

    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: 'group-1', kind: 'unvouched-device' })
    );
  });

  it('says nothing for a device back in this group, a member-signed Add, or this device itself', async () => {
    const { ctx } = makeCtx();
    await deliverDeviceEvents(
      [
        selfEntry({ trust: 'pinned', firstInGroup: false }),
        selfEntry({ addedBy: 'bob:phone-1' }),
        selfEntry({ identity: 'alice:phone-a', addedBy: 'alice:phone-a' }),
      ],
      ctx
    );

    expect(reporter).not.toHaveBeenCalled();
  });

  it('says nothing in a community key group, where every device enters this way', async () => {
    const { ctx } = makeCtx();
    await deliverDeviceEvents([selfEntry({ groupId: 'community-key' })], ctx);

    expect(reporter).not.toHaveBeenCalled();
  });
});
