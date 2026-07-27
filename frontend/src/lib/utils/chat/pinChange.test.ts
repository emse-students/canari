import type { EncryptedMessageRow, IStorage, StoredMessage } from '$lib/db';
import { encryptData } from '$lib/encryption';
import { reencryptLocalMessages } from './pinChange';

/** In-memory IStorage stub that persists real encrypted rows (no IndexedDB). */
function makeEncryptedStorage(): IStorage & { rows: EncryptedMessageRow[] } {
  const rows: EncryptedMessageRow[] = [];
  return {
    rows,
    init: vi.fn().mockResolvedValue(undefined),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    getConversations: vi.fn().mockResolvedValue([]),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    deleteMessagesForConversation: vi.fn().mockResolvedValue(undefined),
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
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

describe('reencryptLocalMessages', () => {
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
