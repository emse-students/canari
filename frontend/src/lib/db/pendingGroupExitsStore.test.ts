/**
 * THE PENDING-EXIT TABLE, AGAINST A REAL STORE.
 *
 * The module that owns the reasoning (`utils/chat/pendingGroupExits`) is tested against a Map, which
 * proves the decisions and nothing about the schema. What this file pins is the half a fake cannot:
 * the v8 upgrade actually creating the object store, and the row surviving a close and a re-open.
 *
 * That distinction is the whole point of the fix. DEL-10's deletion was lost because it lived only
 * in a variable; a row that is written but not durable would be exactly as lost, and a store the
 * upgrade forgot to create fails as a `NotFoundError` inside a best-effort `catch` - which is to say
 * silently, which is to say the same defect again.
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';

let dbCounter = 0;
const freshName = () => `pending-exits-test-${dbCounter++}`;

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';

async function open() {
  const storage = new IndexedDbStorage(freshName());
  await storage.init();
  return storage;
}

describe('the pending group exits table', () => {
  it('exists after the upgrade, and answers empty before anything is owed', async () => {
    const storage = await open();
    expect(await storage.getPendingGroupExits()).toEqual([]);
  });

  it('keeps a row across a close and a re-open, which is the entire point', async () => {
    const name = freshName();
    const first = new IndexedDbStorage(name);
    await first.init();
    await first.savePendingGroupExit({ groupId: G1, kind: 'delete', requestedAt: 42 });
    first.close();

    // A different instance over the same database: what a reload, or an app killed while offline
    // and started again, actually does.
    const second = new IndexedDbStorage(name);
    await second.init();
    expect(await second.getPendingGroupExits()).toEqual([
      { groupId: G1, kind: 'delete', requestedAt: 42 },
    ]);
  });

  it('holds one row per group, so deciding twice cannot queue two calls', async () => {
    const storage = await open();
    await storage.savePendingGroupExit({ groupId: G1, kind: 'delete', requestedAt: 1 });
    await storage.savePendingGroupExit({ groupId: G1, kind: 'leave', requestedAt: 2 });
    const owed = await storage.getPendingGroupExits();
    expect(owed).toHaveLength(1);
    // Last write wins on the primary key: the newer decision is the one the drain must perform.
    expect(owed[0]).toEqual({ groupId: G1, kind: 'leave', requestedAt: 2 });
  });

  it('returns the oldest decision first, so a backlog drains in the order it was made', async () => {
    const storage = await open();
    await storage.savePendingGroupExit({ groupId: G2, kind: 'leave', requestedAt: 200 });
    await storage.savePendingGroupExit({ groupId: G1, kind: 'delete', requestedAt: 100 });
    expect((await storage.getPendingGroupExits()).map((e) => e.groupId)).toEqual([G1, G2]);
  });

  it('deletes exactly the row named, and tolerates one that is already gone', async () => {
    const storage = await open();
    await storage.savePendingGroupExit({ groupId: G1, kind: 'delete', requestedAt: 1 });
    await storage.savePendingGroupExit({ groupId: G2, kind: 'leave', requestedAt: 2 });

    await storage.deletePendingGroupExit(G1);
    expect((await storage.getPendingGroupExits()).map((e) => e.groupId)).toEqual([G2]);

    // The drain clears a row it has just answered; a second pass over the same row must not throw.
    await expect(storage.deletePendingGroupExit(G1)).resolves.toBeUndefined();
  });

  it('is emptied by clear(), like every other table', async () => {
    const storage = await open();
    await storage.savePendingGroupExit({ groupId: G1, kind: 'delete', requestedAt: 1 });
    await storage.clear();
    // A row surviving a logout would replay one user's exit under the next one's session.
    expect(await storage.getPendingGroupExits()).toEqual([]);
  });
});
