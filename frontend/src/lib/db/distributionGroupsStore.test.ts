/**
 * THE KEY-GROUP REGISTRY TABLE, AGAINST A REAL STORE.
 *
 * `BaseMlsService.distributionGroup.test.ts` proves the decisions against a Map and nothing about
 * the schema. What this file pins is the half a fake cannot: the v9 upgrade actually creating the
 * object store, and a row surviving a close and a re-open - which is the whole reason the
 * classification moved out of memory (production, 2026-09-28: a registry rebuilt after the drain
 * refused 51 frames on every load of one device).
 */
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';

let dbCounter = 0;
const freshName = () => `distribution-groups-test-${dbCounter++}`;

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';

async function open(name = freshName()) {
  const storage = new IndexedDbStorage(name);
  await storage.init();
  return storage;
}

describe('the key-group registry table', () => {
  it('exists after the upgrade, and answers empty before anything is registered', async () => {
    const storage = await open();
    expect(await storage.getDistributionGroups()).toEqual([]);
  });

  it('keeps a row across a close and a re-open, which is the entire point', async () => {
    const name = freshName();
    const first = await open(name);
    await first.saveDistributionGroup({ groupId: G1, workspaceId: 'ws-1', channelId: null });
    await first.saveDistributionGroup({ groupId: G2, workspaceId: 'ws-1', channelId: 'chan-1' });
    await first.close();

    // A different instance over the same database: what a reload actually does.
    const second = await open(name);
    const rows = await second.getDistributionGroups();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { groupId: G1, workspaceId: 'ws-1', channelId: null },
        { groupId: G2, workspaceId: 'ws-1', channelId: 'chan-1' },
      ])
    );
  });

  it('holds one row per group, the newer scope winning', async () => {
    const storage = await open();
    await storage.saveDistributionGroup({ groupId: G1, workspaceId: 'ws-1', channelId: null });
    await storage.saveDistributionGroup({ groupId: G1, workspaceId: 'ws-1', channelId: 'chan-1' });
    expect(await storage.getDistributionGroups()).toEqual([
      { groupId: G1, workspaceId: 'ws-1', channelId: 'chan-1' },
    ]);
  });

  it('deletes a row, and a device reset clears the table with the rest', async () => {
    const storage = await open();
    await storage.saveDistributionGroup({ groupId: G1, workspaceId: 'ws-1', channelId: null });
    await storage.saveDistributionGroup({ groupId: G2, workspaceId: 'ws-2', channelId: null });

    await storage.deleteDistributionGroup(G1);
    expect((await storage.getDistributionGroups()).map((r) => r.groupId)).toEqual([G2]);

    await storage.clear();
    expect(await storage.getDistributionGroups()).toEqual([]);
  });
});
