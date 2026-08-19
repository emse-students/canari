/**
 * The Graine session store, exercised against the REAL IndexedDB backend.
 *
 * The SQLite backend cannot be reached from here - it needs a live Tauri SQL plugin - so what
 * holds the two together is the shared codec every method on both sides goes through
 * (`graineCodec`), which is covered below on its own. That split is deliberate and is the same one
 * `sqliteBatch` / `sqliteMigrations` already use: the decisions are pure functions and are tested
 * as such, and the one backend a test runner can actually open is tested for real.
 */
// happy-dom ships no IndexedDB, so the backend is given a real one rather than a mock: these
// tests then exercise the actual cursors, indexes and version migration, which is the only part
// a hand-written double would get wrong silently.
import 'fake-indexeddb/auto';
import { IndexedDbStorage } from './indexeddb';
import { decodeGraineSession, graineClearColumns, byNewestSession } from './graineCodec';
import { decryptData } from '$lib/encryption';
import type { StoredGraineSession } from './types';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

function session(over: Partial<StoredGraineSession> = {}): StoredGraineSession {
  return {
    workspaceId: 'w1',
    channelId: 'c1',
    sessionId: 'sess-1',
    senderId: 'u1',
    seedB64: 'c2VlZC1vbmUtdGhpcnR5LXR3by1ieXRlcy0wMDAwMDA=',
    firstIndex: 0,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

let dbCounter = 0;

async function freshStorage(): Promise<IndexedDbStorage> {
  const storage = new IndexedDbStorage(`graine-test-${dbCounter++}`);
  await storage.init();
  return storage;
}

describe('Graine sessions in IndexedDB', () => {
  it('round-trips a session through encryption', async () => {
    const storage = await freshStorage();
    const s = session();
    await storage.saveGraineSession(s, KEY);

    expect(await storage.getGraineSession('sess-1', KEY)).toEqual(s);
  });

  it('lists a channel newest first', async () => {
    const storage = await freshStorage();
    await storage.saveGraineSession(session({ sessionId: 'old', createdAt: 1000 }), KEY);
    await storage.saveGraineSession(session({ sessionId: 'new', createdAt: 3000 }), KEY);
    await storage.saveGraineSession(session({ sessionId: 'mid', createdAt: 2000 }), KEY);
    // A session of ANOTHER channel, which the channel read must not return.
    await storage.saveGraineSession(session({ sessionId: 'elsewhere', channelId: 'c2' }), KEY);

    const got = await storage.getGraineSessions('c1', KEY);

    expect(got.map((s) => s.sessionId)).toEqual(['new', 'mid', 'old']);
  });

  it('skips a seed sealed under another key rather than losing the batch', async () => {
    const storage = await freshStorage();
    await storage.saveGraineSession(session({ sessionId: 'readable' }), KEY);
    await storage.saveGraineSession(session({ sessionId: 'foreign' }), OTHER_KEY);

    const got = await storage.getGraineSessions('c1', KEY);

    expect(got.map((s) => s.sessionId)).toEqual(['readable']);
  });

  it('purges a community and reports how many it erased', async () => {
    const storage = await freshStorage();
    await storage.saveGraineSession(session({ sessionId: 'a', workspaceId: 'w1' }), KEY);
    await storage.saveGraineSession(session({ sessionId: 'b', workspaceId: 'w1' }), KEY);
    await storage.saveGraineSession(session({ sessionId: 'c', workspaceId: 'w2' }), KEY);

    expect(await storage.deleteGraineSessionsForWorkspace('w1')).toBe(2);
    expect(await storage.getGraineSession('a', KEY)).toBeNull();
    expect(await storage.getGraineSession('c', KEY)).not.toBeNull();
  });

  it('purges without the device key - which is what makes a purge at logout possible', async () => {
    const storage = await freshStorage();
    await storage.saveGraineSession(session({ sessionId: 'a' }), KEY);

    // No key passed, and none needed: the clear columns carry the community.
    expect(await storage.deleteGraineSessionsForWorkspace('w1')).toBe(1);
  });

  it('drops named sessions across communities, counting only what was really there', async () => {
    const storage = await freshStorage();
    await storage.saveGraineSession(session({ sessionId: 'a', workspaceId: 'w1' }), KEY);
    await storage.saveGraineSession(session({ sessionId: 'b', workspaceId: 'w2' }), KEY);
    await storage.saveGraineSession(session({ sessionId: 'c', workspaceId: 'w1' }), KEY);

    // The retention sweep works one SESSION at a time, in communities the device still belongs to,
    // so the scope crosses workspaces on purpose. 'ghost' names nothing: an allowed request, but
    // counting it would overstate every sweep that ran after a partial failure.
    expect(await storage.deleteGraineSessions(['a', 'b', 'ghost'])).toBe(2);
    expect(await storage.getGraineSession('a', KEY)).toBeNull();
    expect(await storage.getGraineSession('b', KEY)).toBeNull();
    expect(await storage.getGraineSession('c', KEY)).not.toBeNull();
  });

  it('asks nothing of the store for an empty list', async () => {
    const storage = await freshStorage();
    await storage.saveGraineSession(session({ sessionId: 'a' }), KEY);

    expect(await storage.deleteGraineSessions([])).toBe(0);
    expect(await storage.getGraineSession('a', KEY)).not.toBeNull();
  });

  it('exports rows with the seed still sealed, and imports them back', async () => {
    const source = await freshStorage();
    await source.saveGraineSession(session(), KEY);

    const rows = await source.getAllEncryptedGraineRows();
    expect(rows).toHaveLength(1);
    // The export must not be a decryption: the seed leaves as ciphertext.
    const payload = await decryptData(rows[0]!.cipherText, rows[0]!.iv, KEY);
    expect((payload as { seedB64: string }).seedB64).toBe(session().seedB64);

    const target = await freshStorage();
    await target.importEncryptedGraineRow(rows[0]!);
    expect(await target.getGraineSession('sess-1', KEY)).toEqual(session());
  });

  it('import never overwrites a live row', async () => {
    const storage = await freshStorage();
    const live = session({ sentCount: 42 });
    await storage.saveGraineSession(live, KEY);
    const [row] = await storage.getAllEncryptedGraineRows();

    // The same session as the backup saw it, before this device sealed 42 messages with it.
    await storage.importEncryptedGraineRow({ ...row!, sentCount: 0 });

    expect((await storage.getGraineSession('sess-1', KEY))!.sentCount).toBe(42);
  });

  it('clear() erases the seeds too', async () => {
    const storage = await freshStorage();
    await storage.saveGraineSession(session(), KEY);

    await storage.clear();

    expect(await storage.getGraineSession('sess-1', KEY)).toBeNull();
  });
});

describe('graineCodec - the seam both backends share', () => {
  it('coerces what SQLite hands back as strings', () => {
    const decoded = decodeGraineSession(
      {
        sessionId: 'sess-1',
        workspaceId: 'w1',
        channelId: 'c1',
        senderId: 'u1',
        firstIndex: '0' as unknown as number,
        createdAt: '1700000000000' as unknown as number,
        sentCount: '7' as unknown as number,
      },
      { seedB64: 'abc' }
    );

    expect(decoded.firstIndex).toBe(0);
    expect(decoded.createdAt).toBe(1_700_000_000_000);
    expect(decoded.sentCount).toBe(7);
  });

  it('reads an absent sentCount as absent, not as zero', () => {
    const decoded = decodeGraineSession(graineClearColumns(session()), { seedB64: 'abc' });
    expect(decoded.sentCount).toBeUndefined();
  });

  it('survives a payload that lost its seed rather than throwing', () => {
    expect(decodeGraineSession(graineClearColumns(session()), {}).seedB64).toBe('');
    expect(decodeGraineSession(graineClearColumns(session()), null).seedB64).toBe('');
  });

  it('orders ties by session id, so two devices keep the same sessions', () => {
    const a = session({ sessionId: 'aaa', createdAt: 5 });
    const b = session({ sessionId: 'bbb', createdAt: 5 });
    expect([b, a].sort(byNewestSession).map((s) => s.sessionId)).toEqual(['aaa', 'bbb']);
  });
});
