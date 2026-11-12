/**
 * A CROSSED 1:1 PAIR - two DM groups for the same two people - MUST END ON THE SAME GROUP FOR
 * EVERYBODY, AND NO GROUP ANYBODY STILL TALKS IN MAY BE DELETED ON THE SERVER.
 *
 * The boot merge used to keep the row with the newest `updatedAt` and delete the other one locally
 * AND on the server. `updatedAt` is a local fact (and ties for a row re-keyed by a Welcome), so the
 * two peers could each keep a different group and each delete the other's choice for everybody:
 * both groups gone ([backlog](../../../../../docs/wiki/backlog.d/p1-the-boot-merge-of-a-crossed-dm-pair-does-not-converge.md)).
 *
 * Each test below models every device of the pair: the rows it stores, the groups it holds (and
 * whether it was evicted from them), and the two ratchet trees - which every member of a group
 * agrees on, so they are SHARED facts. A server delete is recorded in one set the pair shares.
 */
import type { ConversationMeta, IStorage, StoredMessage } from '$lib/db/types';
import type { IMlsService } from '$lib/mls-client/IMlsService';
import { mergeDirectConversationDuplicates } from './conversations';

const ALICE = 'a11ce000-0000-4000-8000-000000000000';
const BOB = 'b0b00000-0000-4000-8000-000000000000';
/** The LOWER group id - the survivor under the convergent rule. */
const LOW = '10000000-0000-4000-8000-00000000000a';
/** The HIGHER group id. */
const HIGH = 'f0000000-0000-4000-8000-00000000000b';

const leaf = (user: string, device: string) => `${user}:${device}`;
const A1 = leaf(ALICE, 'dev-a1');
const A2 = leaf(ALICE, 'dev-a2');
const B1 = leaf(BOB, 'dev-b1');

type Held = 'active' | 'evicted';

/** One device of one person: its own rows, the groups it holds, and its own user id. */
interface Device {
  userId: string;
  peerId: string;
  /** groupId -> updatedAt of the row this device stores (absent: no row). */
  rows: Record<string, number>;
  held: Record<string, Held>;
  /** groupId -> the message ids this device stores under it. */
  messages: Record<string, string[]>;
}

/** The facts every member shares: the ratchet trees, and what the server has deleted. */
interface World {
  trees: Record<string, string[]>;
  serverDeleted: string[];
}

function inMemoryStorage(device: Device, failDeleteOnce = false): IStorage & { dump(): Device } {
  const rows = new Map<string, number>(Object.entries(device.rows));
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
  let failNext = failDeleteOnce;
  return {
    saveConversation: vi.fn(async (meta: ConversationMeta) => {
      rows.set(meta.id, meta.updatedAt);
    }),
    deleteConversation: vi.fn(async (id: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('simulated crash between the move and the delete');
      }
      rows.delete(id);
      for (const [k, m] of messages) if (m.conversationId === id) messages.delete(k);
    }),
    getMessages: vi.fn(async (conv: string) =>
      [...messages.values()].filter((m) => m.conversationId === conv)
    ),
    saveMessages: vi.fn(async (msgs: StoredMessage[]) => {
      for (const m of msgs) messages.set(m.id, m);
    }),
    countMessages: vi.fn(
      async (conv: string) => [...messages.values()].filter((m) => m.conversationId === conv).length
    ),
    dump(): Device {
      const byConv: Record<string, string[]> = {};
      for (const m of messages.values()) (byConv[m.conversationId] ??= []).push(m.id);
      for (const ids of Object.values(byConv)) ids.sort();
      return { ...device, rows: Object.fromEntries(rows), messages: byConv };
    },
  } as unknown as IStorage & { dump(): Device };
}

function mlsFor(device: Device, world: World): IMlsService {
  const holds = (id: string) => {
    if (!(id in device.held)) throw new Error(`group ${id} not held`);
  };
  return {
    heldGroupsKnown: () => true,
    getLocalGroups: () => Object.keys(device.held),
    isGroupActive: async (id: string) => {
      holds(id);
      return device.held[id] === 'active';
    },
    getGroupMemberIdentities: async (id: string) => {
      holds(id);
      return world.trees[id] ?? [];
    },
    deleteGroupOnServer: async (id: string) => {
      world.serverDeleted.push(id);
    },
  } as unknown as IMlsService;
}

function metasOf(device: Device): ConversationMeta[] {
  return Object.entries(device.rows).map(([id, updatedAt]) => ({
    id,
    name: `${device.userId}::${device.peerId}`,
    lifecycle: 'active' as const,
    updatedAt,
  }));
}

/** Runs the NEW boot merge on one device; returns the device as it stands afterwards. */
async function boot(device: Device, world: World, opts: { crash?: boolean } = {}) {
  const storage = inMemoryStorage(device, opts.crash);
  const kept = await mergeDirectConversationDuplicates(
    metasOf(device),
    device.userId,
    'key',
    storage,
    () => {},
    mlsFor(device, world)
  );
  return { kept: kept.map((m) => m.id).sort(), after: storage.dump() };
}

/**
 * The rule a 1.6.6-1.6.10 client still runs: the newest `updatedAt` survives (first in storage
 * order on a tie), every other row is deleted on the server.
 */
function bootOldClient(device: Device, world: World): string {
  const metas = metasOf(device);
  const survivor = metas.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
  for (const m of metas) if (m.id !== survivor.id) world.serverDeleted.push(m.id);
  return survivor.id;
}

const device = (over: Partial<Device> & Pick<Device, 'userId' | 'peerId'>): Device => ({
  rows: {},
  held: {},
  messages: {},
  ...over,
});

describe('a crossed DM pair - the boot merge converges', () => {
  it('1. both peers hold both groups: both keep the LOWER id, whatever each one saw last', async () => {
    // Opposite recencies on the two sides - exactly what made each delete the other's choice.
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    const alice = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 100, [HIGH]: 200 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
    });
    const bob = device({
      userId: BOB,
      peerId: ALICE,
      rows: { [LOW]: 300, [HIGH]: 200 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
    });

    const a = await boot(alice, world);
    const b = await boot(bob, world);

    expect(a.kept).toEqual([LOW]);
    expect(b.kept).toEqual([LOW]);
    // No message lost: the higher group's rows moved into the survivor.
    expect(a.after.messages[LOW]).toEqual(['m-high', 'm-low']);
    expect(b.after.messages[LOW]).toEqual(['m-high', 'm-low']);
    // The survivor is never deleted on the server, by anybody.
    expect(world.serverDeleted).not.toContain(LOW);
  });

  it('1b. a tie on updatedAt (a row re-keyed by a Welcome) picks the same survivor on both sides', async () => {
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    const mk = (userId: string, peerId: string, order: string[]) =>
      device({
        userId,
        peerId,
        rows: Object.fromEntries(order.map((id) => [id, 500])),
        held: { [LOW]: 'active', [HIGH]: 'active' },
      });
    // Opposite storage orders, so "the first one on a tie" differs between the two.
    const a = await boot(mk(ALICE, BOB, [HIGH, LOW]), world);
    const b = await boot(mk(BOB, ALICE, [LOW, HIGH]), world);
    expect(a.kept).toEqual([LOW]);
    expect(b.kept).toEqual([LOW]);
    expect(world.serverDeleted).not.toContain(LOW);
  });

  it('1c. the loser is deleted on the server only when the survivor is strictly the more recent', async () => {
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    await boot(
      device({
        userId: ALICE,
        peerId: BOB,
        rows: { [LOW]: 300, [HIGH]: 200 },
        held: { [LOW]: 'active', [HIGH]: 'active' },
      }),
      world
    );
    expect(world.serverDeleted).toEqual([HIGH]);
  });

  it('2. a partial re-join (Bob holds only the higher group): nobody merges, nobody deletes', async () => {
    // Bob was re-admitted to HIGH only: his leaf is in HIGH's tree, not in LOW's, and he does not
    // hold LOW (its row is a placeholder waiting for a Welcome).
    const world: World = { trees: { [LOW]: [A1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    const alice = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 100, [HIGH]: 50 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
    });
    const bob = device({
      userId: BOB,
      peerId: ALICE,
      rows: { [LOW]: 0, [HIGH]: 200 },
      held: { [HIGH]: 'active' },
      messages: { [HIGH]: ['m-high'] },
    });

    const a = await boot(alice, world);
    const b = await boot(bob, world);

    // Alice must keep HIGH: it is the only group Bob can talk in, and a frame there must land on a row.
    expect(a.kept).toEqual([HIGH, LOW].sort());
    // Bob must keep HIGH: he does not hold the survivor yet.
    expect(b.kept).toEqual([HIGH, LOW].sort());
    expect(b.after.messages[HIGH]).toEqual(['m-high']);
    expect(world.serverDeleted).toEqual([]);
  });

  it('3. a device evicted from the survivor keeps the group it can still use', async () => {
    // Alice's device was removed from LOW's tree; it still holds LOW's state (evicted) and HIGH.
    const world: World = { trees: { [LOW]: [B1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    const a = await boot(
      device({
        userId: ALICE,
        peerId: BOB,
        rows: { [LOW]: 900, [HIGH]: 100 },
        held: { [LOW]: 'evicted', [HIGH]: 'active' },
        messages: { [HIGH]: ['m-high'] },
      }),
      world
    );
    const b = await boot(
      device({
        userId: BOB,
        peerId: ALICE,
        rows: { [LOW]: 900, [HIGH]: 100 },
        held: { [LOW]: 'active', [HIGH]: 'active' },
      }),
      world
    );
    expect(a.kept).toEqual([HIGH, LOW].sort());
    expect(a.after.messages[HIGH]).toEqual(['m-high']);
    // Bob sees Alice's leaf only in HIGH: HIGH is not covered by LOW, so it stays for both.
    expect(b.kept).toEqual([HIGH, LOW].sort());
    expect(world.serverDeleted).toEqual([]);
  });

  it('3b. a device evicted from the LOSER merges it locally and deletes nothing on the server', async () => {
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [B1] }, serverDeleted: [] };
    const a = await boot(
      device({
        userId: ALICE,
        peerId: BOB,
        rows: { [LOW]: 100, [HIGH]: 900 },
        held: { [LOW]: 'active', [HIGH]: 'evicted' },
        messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
      }),
      world
    );
    expect(a.kept).toEqual([LOW]);
    expect(a.after.messages[LOW]).toEqual(['m-high', 'm-low']);
    expect(world.serverDeleted).toEqual([]);
  });

  it('4. a second device that does not hold the survivor holds the merge back on BOTH devices', async () => {
    // a2 is only in HIGH (its Welcome to LOW is owed). a1 must not orphan what a2 sends in HIGH.
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [A1, A2, B1] }, serverDeleted: [] };
    const a1 = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 300, [HIGH]: 100 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
    });
    const a2 = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 0, [HIGH]: 100 },
      held: { [HIGH]: 'active' },
    });
    expect((await boot(a1, world)).kept).toEqual([HIGH, LOW].sort());
    expect((await boot(a2, world)).kept).toEqual([HIGH, LOW].sort());
    expect(world.serverDeleted).toEqual([]);

    // Once a2 is in LOW, every device lands on LOW.
    world.trees[LOW] = [A1, A2, B1];
    a2.held[LOW] = 'active';
    expect((await boot(a1, world)).kept).toEqual([LOW]);
    expect((await boot(a2, world)).kept).toEqual([LOW]);
    expect(world.serverDeleted).not.toContain(LOW);
  });

  it('5. a crash between the move and the local delete: the next boot finishes onto the SAME survivor', async () => {
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    const alice = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 100, [HIGH]: 900 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
      messages: { [LOW]: ['m-low'], [HIGH]: ['m-high'] },
    });
    const first = await boot(alice, world, { crash: true });
    // The rows moved, the losing row stayed, and nothing was deleted on the server.
    expect(first.after.messages[LOW]).toEqual(['m-high', 'm-low']);
    expect(Object.keys(first.after.rows).sort()).toEqual([HIGH, LOW].sort());
    expect(world.serverDeleted).toEqual([]);

    const second = await boot(first.after, world);
    expect(second.kept).toEqual([LOW]);
    expect(second.after.messages[LOW]).toEqual(['m-high', 'm-low']);
    expect(world.serverDeleted).not.toContain(LOW);
  });

  it('6. a mixed pair whose old client keeps the HIGHER group: the new client deletes nothing on the server', async () => {
    // The old client sees HIGH as the newer and deletes LOW for everybody. If the new client also
    // deleted HIGH, both groups would be gone - the P1. It holds the delete back instead.
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    const newAlice = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 100, [HIGH]: 200 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
    });
    const oldBob = device({ userId: BOB, peerId: ALICE, rows: { [LOW]: 100, [HIGH]: 200 } });

    await boot(newAlice, world);
    const oldChoice = bootOldClient(oldBob, world);

    expect(oldChoice).toBe(HIGH);
    expect(world.serverDeleted).toEqual([LOW]);
    expect(world.serverDeleted).not.toContain(HIGH);
  });

  it('6b. a mixed pair whose old client keeps the LOWER group: both end on it', async () => {
    const world: World = { trees: { [LOW]: [A1, B1], [HIGH]: [A1, B1] }, serverDeleted: [] };
    const newAlice = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 300, [HIGH]: 200 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
    });
    const oldBob = device({ userId: BOB, peerId: ALICE, rows: { [LOW]: 300, [HIGH]: 200 } });

    const a = await boot(newAlice, world);
    expect(bootOldClient(oldBob, world)).toBe(LOW);
    expect(a.kept).toEqual([LOW]);
    expect(world.serverDeleted).not.toContain(LOW);
  });

  it('decides nothing while the held groups are not known', async () => {
    const world: World = { trees: {}, serverDeleted: [] };
    const alice = device({
      userId: ALICE,
      peerId: BOB,
      rows: { [LOW]: 100, [HIGH]: 200 },
      held: { [LOW]: 'active', [HIGH]: 'active' },
    });
    const storage = inMemoryStorage(alice);
    const mls = { ...mlsFor(alice, world), heldGroupsKnown: () => false } as IMlsService;
    const kept = await mergeDirectConversationDuplicates(
      metasOf(alice),
      ALICE,
      'key',
      storage,
      () => {},
      mls
    );
    expect(kept.map((m) => m.id).sort()).toEqual([HIGH, LOW].sort());
    expect(storage.deleteConversation).not.toHaveBeenCalled();
    expect(world.serverDeleted).toEqual([]);
  });
});
