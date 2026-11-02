/**
 * THE SQLITE PAIR WRITE IS TWO STATEMENTS, AND A TEAR SAYS WHICH HALF LANDED (review of #2874, M2).
 *
 * `tauri-plugin-sql` pools its connections, so a message and its outbox entry cannot share one
 * transaction (`sqliteBatch.ts`): the entry is written first. A message write failing after it used
 * to throw the same error as a pair that wrote nothing, and the send path then wrote the entry again
 * (a second blob in its slot) and gave the file back for a second send (a duplicate). It is typed now.
 */
import { SqliteStorage } from './sqlite';
import {
  MessagePairWriteError,
  OutboxEntryWrittenAloneError,
} from '$lib/utils/chat/messageWrittenError';
import type { OutboxEntry, StoredMessage } from './types';

const KEY = 'device-key';
const message = { id: 'm-1', conversationId: 'g-1' } as unknown as StoredMessage;
const entry = { id: 'm-1', conversationId: 'g-1', kind: 'media' } as unknown as OutboxEntry;

function storageWith(writes: { entry: () => Promise<void>; message: () => Promise<void> }) {
  const storage = new SqliteStorage('u');
  const saveOutboxEntry = vi.spyOn(storage, 'saveOutboxEntry').mockImplementation(writes.entry);
  const saveMessages = vi.spyOn(storage, 'saveMessages').mockImplementation(writes.message);
  return { storage, saveOutboxEntry, saveMessages };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('SqliteStorage.saveMessageWithOutboxEntry', () => {
  it('writes the entry FIRST, then the message', async () => {
    const order: string[] = [];
    const { storage } = storageWith({
      entry: async () => void order.push('entry'),
      message: async () => void order.push('message'),
    });
    await storage.saveMessageWithOutboxEntry(message, entry, KEY);
    expect(order).toEqual(['entry', 'message']);
  });

  it('a message write failing after the entry landed is an OutboxEntryWrittenAloneError', async () => {
    const { storage } = storageWith({
      entry: async () => {},
      message: async () => {
        throw new Error('disk I/O error');
      },
    });
    const torn = storage.saveMessageWithOutboxEntry(message, entry, KEY);
    await expect(torn).rejects.toBeInstanceOf(OutboxEntryWrittenAloneError);
    await expect(torn).rejects.toMatchObject({ messageId: 'm-1' });
    // What the send path reads off it: the queue already owns the row.
    const reported = await torn.then(
      () => null,
      (e: unknown) => new MessagePairWriteError('m-1', e)
    );
    expect(reported?.entryWritten).toBe(true);
  });

  it('an entry write that fails is NOT reported as written, and the message is not attempted', async () => {
    const { storage, saveMessages } = storageWith({
      entry: async () => {
        throw new Error('database is locked');
      },
      message: async () => {},
    });
    const failed = storage.saveMessageWithOutboxEntry(message, entry, KEY);
    await expect(failed).rejects.not.toBeInstanceOf(OutboxEntryWrittenAloneError);
    const reported = await failed.then(
      () => null,
      (e: unknown) => new MessagePairWriteError('m-1', e)
    );
    expect(reported?.entryWritten).toBe(false);
    expect(saveMessages).not.toHaveBeenCalled();
  });
});
