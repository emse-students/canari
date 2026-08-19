import type {
  EncryptedGraineRow,
  EncryptedMessageRow,
  IStorage,
  StoredGraineSession,
  StoredMessage,
} from '$lib/db';
import { encryptData, decryptData } from '$lib/encryption';
import {
  graineClearColumns,
  encodeGraineSensitive,
  decodeGraineSession,
} from '$lib/db/graineCodec';
import { reencryptGraineSessions, reencryptLocalMessages } from './pinChange';
import { setLocale } from '$lib/paraglide/runtime';

/** In-memory IStorage stub that persists real encrypted rows (no IndexedDB). */
function makeEncryptedStorage(): IStorage & {
  rows: EncryptedMessageRow[];
  graineRows: EncryptedGraineRow[];
} {
  const rows: EncryptedMessageRow[] = [];
  const graineRows: EncryptedGraineRow[] = [];
  return {
    rows,
    graineRows,
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getConversations: vi.fn().mockResolvedValue([]),
    getConversation: vi.fn().mockResolvedValue(null),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    deleteMessagesForConversation: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn(),
    saveMessages: vi.fn(async (msgs: StoredMessage[], deviceKeyB64: string) => {
      for (const msg of msgs) {
        const payload: Record<string, unknown> = {
          senderId: msg.senderId,
          content: msg.content,
        };
        const encrypted = await encryptData(payload, deviceKeyB64);
        const row: EncryptedMessageRow = {
          id: msg.id,
          conversationId: msg.conversationId,
          timestamp: msg.timestamp,
          iv: encrypted.iv,
          cipherText: encrypted.cipherText,
        };
        const idx = rows.findIndex((r) => r.id === row.id);
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
      }
    }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn(),
    getMessagesPage: vi.fn(),
    deleteOldMessages: vi.fn().mockResolvedValue(0),
    getAllEncryptedRows: vi.fn(async () => rows.slice()),
    mergeConversation: vi.fn().mockResolvedValue(undefined),
    importEncryptedRow: vi.fn().mockResolvedValue(undefined),
    saveOutboxEntry: vi.fn().mockResolvedValue(undefined),
    getOutboxEntries: vi.fn().mockResolvedValue([]),
    getOutboxEntriesForConversation: vi.fn().mockResolvedValue([]),
    updateOutboxEntry: vi.fn().mockResolvedValue(undefined),
    deleteOutboxEntry: vi.fn().mockResolvedValue(undefined),
    // Graine: really encrypted, like the messages above, so a re-encryption can be OBSERVED
    // rather than asserted on a spy call.
    saveGraineSession: vi.fn(async (session: StoredGraineSession, deviceKeyB64: string) => {
      const encrypted = await encryptData(encodeGraineSensitive(session), deviceKeyB64);
      const row: EncryptedGraineRow = { ...graineClearColumns(session), ...encrypted };
      const idx = graineRows.findIndex((r) => r.sessionId === row.sessionId);
      if (idx >= 0) graineRows[idx] = row;
      else graineRows.push(row);
    }),
    getGraineSessions: vi.fn().mockResolvedValue([]),
    getGraineSession: vi.fn().mockResolvedValue(null),
    getGraineSessionsForWorkspace: vi.fn().mockResolvedValue([]),
    deleteGraineSessionsForWorkspace: vi.fn().mockResolvedValue(0),
    deleteGraineSessions: vi.fn().mockResolvedValue(0),
    getAllEncryptedGraineRows: vi.fn(async () => graineRows.slice()),
    importEncryptedGraineRow: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

/** A session whose only interesting field is the seed the re-encryption has to preserve. */
function makeSession(sessionId: string, seedB64: string): StoredGraineSession {
  return {
    workspaceId: 'w1',
    channelId: 'c1',
    sessionId,
    senderId: 'u1',
    seedB64,
    firstIndex: 0,
    createdAt: 1_700_000_000_000,
    sentCount: 3,
  };
}

describe('reencryptLocalMessages', () => {
  // The expected sentence is French, so the locale is PINNED rather than inherited: the
  // resolution order ends in `preferredLanguage`, and happy-dom prefers English - which made
  // this assertion depend on a dependency's default instead of on the code.
  beforeEach(() => setLocale('fr', { reload: false }));

  const oldKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const newKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

  it('re-encrypts stored messages so the new device key can read them', async () => {
    const storage = makeEncryptedStorage();
    await storage.saveMessages(
      [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderId: 'alice',
          content: '{"type":"text","body":"hello"}',
          timestamp: 1_700_000_000_000,
        },
      ],
      oldKey
    );

    const count = await reencryptLocalMessages(storage, oldKey, newKey);
    expect(count).toBe(1);
    expect(storage.rows).toHaveLength(1);

    const { decryptData } = await import('$lib/encryption');
    const row = storage.rows[0]!;
    await expect(decryptData(row.cipherText, row.iv, oldKey)).rejects.toThrow();
    const payload = await decryptData(row.cipherText, row.iv, newKey);
    expect((payload as Record<string, unknown>).content).toBe('{"type":"text","body":"hello"}');
  });

  it('throws when no message decrypts with the old device key', async () => {
    const storage = makeEncryptedStorage();
    await storage.saveMessages(
      [
        {
          id: 'msg-2',
          conversationId: 'conv-1',
          senderId: 'alice',
          content: 'secret',
          timestamp: 1_700_000_000_001,
        },
      ],
      oldKey
    );

    await expect(
      reencryptLocalMessages(storage, 'wrong-key-base64-string-aaaaaaaaaaaaaa=', newKey)
    ).rejects.toThrow(/Impossible de déchiffrer les messages locaux/);
  });

  it('is a no-op when old and new device key are identical', async () => {
    const storage = makeEncryptedStorage();
    await storage.saveMessages(
      [
        {
          id: 'msg-3',
          conversationId: 'conv-1',
          senderId: 'alice',
          content: 'same',
          timestamp: 1_700_000_000_002,
        },
      ],
      oldKey
    );
    const before = storage.rows[0]!.cipherText.slice();

    const count = await reencryptLocalMessages(storage, oldKey, oldKey);
    expect(count).toBe(0);
    expect(storage.rows[0]!.cipherText).toEqual(before);
  });
});

describe('reencryptGraineSessions', () => {
  const oldKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const newKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
  const seedB64 = 'c2VlZC1vbmUtdGhpcnR5LXR3by1ieXRlcy0wMDAwMDA=';

  it('re-seals every seed under the new key, seed and clear columns intact', async () => {
    const storage = makeEncryptedStorage();
    await storage.saveGraineSession(makeSession('sess-1', seedB64), oldKey);

    const count = await reencryptGraineSessions(storage, oldKey, newKey);

    expect(count).toBe(1);
    const row = storage.graineRows[0]!;
    const payload = await decryptData(row.cipherText, row.iv, newKey);
    expect(decodeGraineSession(row, payload)).toEqual(makeSession('sess-1', seedB64));
  });

  it('leaves nothing readable under the old key', async () => {
    const storage = makeEncryptedStorage();
    await storage.saveGraineSession(makeSession('sess-1', seedB64), oldKey);

    await reencryptGraineSessions(storage, oldKey, newKey);

    const row = storage.graineRows[0]!;
    await expect(decryptData(row.cipherText, row.iv, oldKey)).rejects.toThrow();
  });

  it('skips a corrupt seed and keeps going, rather than stranding the rest', async () => {
    const storage = makeEncryptedStorage();
    await storage.saveGraineSession(makeSession('sess-good', seedB64), oldKey);
    await storage.saveGraineSession(makeSession('sess-bad', seedB64), oldKey);
    // Corrupt one row's ciphertext in place: it can no longer authenticate under any key.
    storage.graineRows[1]!.cipherText[0] ^= 0xff;

    const count = await reencryptGraineSessions(storage, oldKey, newKey);

    expect(count).toBe(1);
    const good = storage.graineRows.find((r) => r.sessionId === 'sess-good')!;
    const payload = await decryptData(good.cipherText, good.iv, newKey);
    expect((payload as { seedB64: string }).seedB64).toBe(seedB64);
  });

  it('is a no-op when old and new device key are identical', async () => {
    const storage = makeEncryptedStorage();
    await storage.saveGraineSession(makeSession('sess-1', seedB64), oldKey);
    const before = storage.graineRows[0]!.cipherText.slice();

    const count = await reencryptGraineSessions(storage, oldKey, oldKey);

    expect(count).toBe(0);
    expect(storage.graineRows[0]!.cipherText).toEqual(before);
  });
});
