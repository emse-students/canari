/**
 * A CROSSED 1:1 PAIR - two DM groups for the same two people - MAY NEVER LOSE BOTH GROUPS TO TWO
 * CLIENTS RUNNING THIS RULE, AND A GROUP THIS DEVICE HOLDS AND THE SERVER STILL ROUTES ALWAYS KEEPS
 * A ROW FOR ITS FRAMES TO LAND ON.
 *
 * The boot merge keeps the newest `updatedAt` (the rule a Welcome re-key agrees with, and the one a
 * 1.6.6-1.6.10 peer still runs) and folds the rest into it, deleting them on the server. Recency is
 * local, so two peers could each keep a different group and delete the other's choice: both gone.
 * Now a device folds only when its recency keeps the LOWEST id (a tie counts as the lowest), and
 * otherwise decides nothing - so the lowest id is never deleted by a new client
 * ([history-reconciliation](../../../../../docs/wiki/protocols/history-reconciliation.md#a-crossed-11-pair-the-lower-id-is-never-deleted-2026-11-12)).
 *
 * Each test models every device of the pair: its rows and their recency, the messages under each,
 * the groups it holds - and the server, which routes frames for every group it has not deleted.
 */
import type { ConversationMeta, IStorage, StoredMessage } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { GroupExitRefusedError } from '$lib/mls-client/mlsDeliveryApi';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { mergeDirectConversationDuplicates } from './conversations';

const ALICE = 'a11ce000-0000-4000-8000-000000000000';
const BOB = 'b0b00000-0000-4000-8000-000000000000';
/** The LOWER group id - the one no new client ever deletes. */
const LOW = '10000000-0000-4000-8000-00000000000a';
/** The HIGHER group id. */
const HIGH = 'f0000000-0000-4000-8000-00000000000b';

/** One device: its rows (groupId -> updatedAt, in storage order), its messages, what it holds. */
interface Device {
  userId: string;
  peerId: string;
  rows: Array<[string, number]>;
  messages: Record<string, string[]>;
  held: string[];
}

/**
 * The server: what it has deleted, and the deletes that fail before reaching it (groupId -> what
 * the call throws: no answer, or a refusal).
 */
interface Server {
  deleted: string[];
  failing: Map<string, () => Error>;
}

const newServer = (): Server => ({ deleted: [], failing: new Map() });

/**
 * What the delivery service answers a delete of a group it has ALREADY deleted: the tombstone purged
 * every seat, so the caller is no member - the 403 `NOT_A_MEMBER` in its own envelope, typed the way
 * `MlsDeliveryApi.deleteGroupOnServer` types it (`groupExitRefusal`).
 */
const notAMember = (id: string) =>
  new GroupExitRefusedError(id, 403, 'delete', 'gateway', 'NOT_A_MEMBER');

/** No answer at all - the type `isTransportFailure` reads (`unreachable`). */
const noAnswer = () => new TransportFailureError('error sending request');
/** An edge's 403 page, which says nothing about the group (`refused`). */
const edgeRefusal = (id: string) => () => new GroupExitRefusedError(id, 403, 'delete', 'edge');
/** The delivery service up and unhappy (`refused`). */
const serverError = (id: string) => () =>
  new GroupExitRefusedError(id, 500, 'delete', 'gateway', 'INTERNAL');

function storageOf(device: Device): IStorage {
  const messages = new Map<string, StoredMessage>();
  for (const [conv, ids] of Object.entries(device.messages)) {
    for (const id of ids) {
      messages.set(id, {
        id,
        conversationId: conv,
        senderId: device.userId,
        content: id,
        timestamp: 1,
      });
    }
  }
  const sync = () => {
    const byConv: Record<string, string[]> = {};
    for (const m of messages.values()) (byConv[m.conversationId] ??= []).push(m.id);
    for (const ids of Object.values(byConv)) ids.sort();
    device.messages = byConv;
  };
  return {
    saveConversation: vi.fn(async () => {}),
    deleteConversation: vi.fn(async (id: string) => {
      device.rows = device.rows.filter(([g]) => g !== id);
      for (const [k, m] of messages) if (m.conversationId === id) messages.delete(k);
      sync();
    }),
    getMessages: vi.fn(async (conv: string) =>
      [...messages.values()].filter((m) => m.conversationId === conv)
    ),
    saveMessages: vi.fn(async (msgs: StoredMessage[]) => {
      for (const m of msgs) messages.set(m.id, m);
      sync();
    }),
    countMessages: vi.fn(
      async (conv: string) => [...messages.values()].filter((m) => m.conversationId === conv).length
    ),
  } as unknown as IStorage;
}

function metasOf(device: Device): ConversationMeta[] {
  return device.rows.map(([id, updatedAt]) => ({
    id,
    name: `${device.userId}::${device.peerId}`,
    lifecycle: 'active' as const,
    updatedAt,
  }));
}

/** Runs the boot merge of THIS rule on one device, mutating the device; returns its log. */
async function boot(device: Device, server: Server): Promise<string[]> {
  const lines: string[] = [];
  await mergeDirectConversationDuplicates(
    metasOf(device),
    device.userId,
    'key',
    storageOf(device),
    (l) => lines.push(l),
    {
      deleteGroupOnServer: async (id: string) => {
        const failure = server.failing.get(id);
        if (failure) throw failure();
        if (server.deleted.includes(id)) throw notAMember(id);
        server.deleted.push(id);
      },
    } as unknown as IMlsService
  );
  return lines;
}

/** The rule a 1.6.6-1.6.10 client still runs: newest `updatedAt` (first in storage order on a tie). */
function bootOldClient(device: Device, server: Server): string {
  const survivor = device.rows.reduce((a, b) => (a[1] >= b[1] ? a : b));
  for (const [id] of device.rows) if (id !== survivor[0]) server.deleted.push(id);
  device.rows = [survivor];
  return survivor[0];
}

/**
 * A Welcome into `joined` for a peer this device already holds a DM with (`upsertConversation` +
 * `runPendingRekey`): the stored rows move onto the joined group, whose row carries the old row's
 * `updatedAt`, and the old row is KEPT.
 */
function welcomeRekey(device: Device, joined: string): void {
  const [oldId, updatedAt] = device.rows[0];
  device.messages[joined] = [...(device.messages[joined] ?? []), ...(device.messages[oldId] ?? [])];
  delete device.messages[oldId];
  device.rows = [[joined, updatedAt], ...device.rows];
  device.held.push(joined);
}

const rowIds = (d: Device) => d.rows.map(([g]) => g).sort();

/** THE INVARIANT: every group this device holds and the server still routes has a row here. */
function expectEveryRoutedGroupHasARow(d: Device, server: Server): void {
  for (const g of d.held) {
    if (!server.deleted.includes(g)) expect(rowIds(d)).toContain(g);
  }
}

const both = { held: [LOW, HIGH] };

describe('a crossed DM pair - the boot merge never loses both groups', () => {
  it('opposite recencies: the one whose recency keeps LOW folds, the other decides nothing', async () => {
    const server = newServer();
    const alice: Device = {
      userId: ALICE,
      peerId: BOB,
      rows: [
        [LOW, 100],
        [HIGH, 200],
      ],
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
      ...structuredClone(both),
    };
    const bob: Device = {
      userId: BOB,
      peerId: ALICE,
      rows: [
        [LOW, 300],
        [HIGH, 200],
      ],
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
      ...structuredClone(both),
    };

    await boot(alice, server);
    await boot(bob, server);

    // The rule this replaces had Alice delete LOW and Bob delete HIGH: both gone.
    expect(server.deleted).toEqual([HIGH]);
    expect(rowIds(alice)).toEqual([HIGH, LOW].sort());
    expect(alice.messages).toEqual({ [LOW]: ['m-low'], [HIGH]: ['m-high'] });
    expect(rowIds(bob)).toEqual([LOW]);
    expect(bob.messages[LOW]).toEqual(['m-high', 'm-low']);
    expectEveryRoutedGroupHasARow(alice, server);
    expectEveryRoutedGroupHasARow(bob, server);
  });

  it('both recencies keep HIGH: nobody deletes anything, until a message in LOW folds the pair', async () => {
    const server = newServer();
    const mk = (userId: string, peerId: string): Device => ({
      userId,
      peerId,
      rows: [
        [LOW, 100],
        [HIGH, 200],
      ],
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
      ...structuredClone(both),
    });
    const alice = mk(ALICE, BOB);
    const bob = mk(BOB, ALICE);
    await boot(alice, server);
    await boot(bob, server);
    expect(server.deleted).toEqual([]);
    expect(rowIds(alice)).toEqual([HIGH, LOW].sort());
    expect(rowIds(bob)).toEqual([HIGH, LOW].sort());

    // A message in LOW makes it the more recent on both sides; the next boot folds HIGH into it.
    // Alice deletes HIGH; Bob's delete is answered the 403 `NOT_A_MEMBER` and still ends his row.
    for (const d of [alice, bob]) d.rows = d.rows.map(([g, t]) => [g, g === LOW ? 300 : t]);
    await boot(alice, server);
    const bobLog = await boot(bob, server);
    expect(rowIds(alice)).toEqual([LOW]);
    expect(rowIds(bob)).toEqual([LOW]);
    expect(bob.messages[LOW]).toEqual(['m-high', 'm-low']);
    expect(server.deleted).toEqual([HIGH]);
    expect(bobLog.some((l) => l.includes('the server had already deleted it'))).toBe(true);
  });

  it('the second device to fold is answered NOT_A_MEMBER and still ends with LOW alone', async () => {
    const server = newServer();
    // The same user on two devices, both of whose recencies keep LOW.
    const mk = (): Device => ({
      userId: ALICE,
      peerId: BOB,
      rows: [
        [LOW, 300],
        [HIGH, 200],
      ],
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
      ...structuredClone(both),
    });
    const phone = mk();
    const laptop = mk();
    await boot(phone, server);
    await boot(laptop, server);
    expect(server.deleted).toEqual([HIGH]);
    for (const d of [phone, laptop]) {
      expect(rowIds(d)).toEqual([LOW]);
      expect(d.messages).toEqual({ [LOW]: ['m-high', 'm-low'] });
      expectEveryRoutedGroupHasARow(d, server);
    }
    // And the next boot has nothing left to retry.
    expect(await boot(laptop, server)).toEqual([]);
  });

  it('a device killed between the server delete and the local one: the next boot finishes it', async () => {
    const server = newServer();
    // The first boot moved HIGH's rows and deleted HIGH on the server, then the app died.
    server.deleted.push(HIGH);
    const alice: Device = {
      userId: ALICE,
      peerId: BOB,
      rows: [
        [LOW, 300],
        [HIGH, 100],
      ],
      messages: { [LOW]: ['m-high', 'm-low'] },
      ...structuredClone(both),
    };
    await boot(alice, server);
    expect(rowIds(alice)).toEqual([LOW]);
    expect(alice.messages).toEqual({ [LOW]: ['m-high', 'm-low'] });
    expect(server.deleted).toEqual([HIGH]);
  });

  it('a tie on updatedAt folds into LOW whatever the storage order', async () => {
    const server = newServer();
    const mk = (userId: string, peerId: string, rows: Array<[string, number]>): Device => ({
      userId,
      peerId,
      rows,
      messages: {},
      ...structuredClone(both),
    });
    const alice = mk(ALICE, BOB, [
      [HIGH, 500],
      [LOW, 500],
    ]);
    const bob = mk(BOB, ALICE, [
      [LOW, 500],
      [HIGH, 500],
    ]);
    await boot(alice, server);
    await boot(bob, server);
    expect(rowIds(alice)).toEqual([LOW]);
    expect(rowIds(bob)).toEqual([LOW]);
    expect(server.deleted).not.toContain(LOW);
  });

  it('a Welcome into HIGH between two boots: the tie it leaves folds back into LOW', async () => {
    const server = newServer();
    const alice: Device = {
      userId: ALICE,
      peerId: BOB,
      rows: [[LOW, 100]],
      messages: { [LOW]: ['m-1', 'm-2'] },
      held: [LOW],
    };
    welcomeRekey(alice, HIGH);
    expect(alice.messages).toEqual({ [HIGH]: ['m-1', 'm-2'] });

    await boot(alice, server);
    expect(rowIds(alice)).toEqual([LOW]);
    expect(alice.messages).toEqual({ [LOW]: ['m-1', 'm-2'] });
    expect(server.deleted).toEqual([HIGH]);
  });

  it('a Welcome into HIGH, then a message there: nothing is decided and HIGH keeps its row', async () => {
    const server = newServer();
    const alice: Device = {
      userId: ALICE,
      peerId: BOB,
      rows: [[LOW, 100]],
      messages: { [LOW]: ['m-1'] },
      held: [LOW],
    };
    welcomeRekey(alice, HIGH);
    alice.rows = alice.rows.map(([g, t]) => [g, g === HIGH ? 200 : t]);

    await boot(alice, server);
    expect(rowIds(alice)).toEqual([HIGH, LOW].sort());
    expect(alice.messages).toEqual({ [HIGH]: ['m-1'] });
    expect(server.deleted).toEqual([]);
    expectEveryRoutedGroupHasARow(alice, server);
  });

  it.each([
    ['no answer (unreachable)', () => noAnswer],
    ["an edge's 403 (refused)", () => edgeRefusal(HIGH)],
    ["the delivery service's 500 (refused)", () => serverError(HIGH)],
  ])(
    'a server delete that gets %s keeps the row its frames still need; the next boot finishes',
    async (_label, failure) => {
      const server = newServer();
      server.failing.set(HIGH, failure());
      const alice: Device = {
        userId: ALICE,
        peerId: BOB,
        rows: [
          [LOW, 300],
          [HIGH, 100],
        ],
        messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
        ...structuredClone(both),
      };
      await boot(alice, server);
      // The rows moved, the row stayed: the server still routes HIGH's frames to this device.
      expect(alice.messages[LOW]).toEqual(['m-high', 'm-low']);
      expect(rowIds(alice)).toEqual([HIGH, LOW].sort());
      expectEveryRoutedGroupHasARow(alice, server);

      server.failing.clear();
      await boot(alice, server);
      expect(rowIds(alice)).toEqual([LOW]);
      expect(alice.messages[LOW]).toEqual(['m-high', 'm-low']);
      expect(server.deleted).toEqual([HIGH]);
    }
  );

  describe('a mixed pair - a 1.6.6-1.6.10 peer still on recency', () => {
    const mk = (userId: string, peerId: string, low: number, high: number): Device => ({
      userId,
      peerId,
      rows: [
        [LOW, low],
        [HIGH, high],
      ],
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
      ...structuredClone(both),
    });

    it('both keep HIGH: the old client deletes LOW, the new one holds - HIGH survives, no history moved', async () => {
      const server = newServer();
      const alice = mk(ALICE, BOB, 100, 200);
      await boot(alice, server);
      expect(bootOldClient(mk(BOB, ALICE, 100, 200), server)).toBe(HIGH);
      expect(server.deleted).toEqual([LOW]);
      // Nothing moved under LOW, so nothing ends under its tombstone.
      expect(alice.messages).toEqual({ [LOW]: ['m-low'], [HIGH]: ['m-high'] });
      expectEveryRoutedGroupHasARow(alice, server);
    });

    it('both keep LOW: both delete HIGH, LOW survives', async () => {
      const server = newServer();
      const alice = mk(ALICE, BOB, 300, 200);
      await boot(alice, server);
      expect(bootOldClient(mk(BOB, ALICE, 300, 200), server)).toBe(LOW);
      expect(server.deleted).not.toContain(LOW);
      expect(rowIds(alice)).toEqual([LOW]);
    });

    it('the new one keeps LOW, the old one HIGH: both are deleted - the race main always had, until the floor passes', async () => {
      // Pinned so that the limit is a decision on record, not a surprise: no client-only rule can
      // stop an old client from deleting LOW.
      const server = newServer();
      await boot(mk(ALICE, BOB, 300, 200), server);
      expect(bootOldClient(mk(BOB, ALICE, 100, 200), server)).toBe(HIGH);
      expect(server.deleted.sort()).toEqual([HIGH, LOW].sort());
    });
  });

  it('says a held-back pair once per session, however many restores run', async () => {
    const server = newServer();
    // An account of its own: the session's report set already holds Alice's pair from the cases above.
    const alice: Device = {
      userId: 'c0ffee00-0000-4000-8000-000000000000',
      peerId: BOB,
      rows: [
        [LOW, 100],
        [HIGH, 200],
      ],
      messages: {},
      ...structuredClone(both),
    };
    const first = await boot(alice, server);
    const second = await boot(alice, server);
    expect(first.filter((l) => l.startsWith('[DM_MERGE]'))).toHaveLength(1);
    expect(second.filter((l) => l.startsWith('[DM_MERGE]'))).toHaveLength(0);
  });
});
