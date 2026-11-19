import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { classifyRowWriteFailure, RowRefusedError } from './rowWriteFailure';
import { IndexedDbStorage } from './indexeddb';
import type { StoredMessage } from './types';

/**
 * A ROW THE STORE REFUSES FOR WHAT IT IS IS POISON; ANYTHING ELSE IS TRANSIENT (reviews of #3851).
 * Decided by a TYPE the store raises at the refused request (`RowRefusedError`) - never by a message,
 * and never by a `DOMException` name read off whatever reached the writer: `crypto.subtle.importKey`
 * raises `DataError` for an empty device key, which is not a refused row.
 */
describe('classifyRowWriteFailure', () => {
  it.each(['DataError', 'DataCloneError'])(
    'a row the store refused at its own request with %s is poison',
    (name) => {
      const refused = new RowRefusedError('row-1', new DOMException('refused', name));
      expect(refused.domName).toBe(name);
      expect(classifyRowWriteFailure(refused)).toBe('poison');
    }
  );

  it.each(['QuotaExceededError', 'AbortError', 'TransactionInactiveError', 'UnknownError'])(
    'a refused row whose refusal is %s - a failure a retry may pass - is transient',
    (name) => {
      expect(
        classifyRowWriteFailure(new RowRefusedError('row-1', new DOMException('refused', name)))
      ).toBe('transient');
    }
  );

  it('a BARE DataError (a key import with an empty device key) or DataCloneError is transient: not raised at a row', () => {
    expect(classifyRowWriteFailure(new DOMException('empty key', 'DataError'))).toBe('transient');
    expect(classifyRowWriteFailure(new DOMException('conversation row', 'DataCloneError'))).toBe(
      'transient'
    );
  });

  it('never reads a message: an untyped error or a string NAMING a poison class is transient', () => {
    expect(classifyRowWriteFailure(new Error('DataError: bad key'))).toBe('transient');
    expect(classifyRowWriteFailure('saveMessagesIfAbsent error: DataCloneError')).toBe('transient');
    expect(classifyRowWriteFailure(null)).toBe('transient');
    expect(classifyRowWriteFailure(undefined)).toBe('transient');
  });
});

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
let dbCounter = 0;

describe('IndexedDbStorage raises RowRefusedError at the refused row, and nothing of its batch lands', () => {
  it('a row whose key the store cannot take rejects the write with RowRefusedError(DataError)', async () => {
    const storage = new IndexedDbStorage(`row-refused-${dbCounter++}`);
    await storage.init();
    const good = {
      id: 'good-row',
      conversationId: 'c1',
      senderId: 'peer',
      content: 'fine',
      timestamp: 1_700_000_000_000,
    } as StoredMessage;
    // An object is not a valid IndexedDB key: the `add` of this row throws `DataError` synchronously.
    const bad = { ...good, id: { not: 'a key' } as unknown as string };

    const write = storage.saveMessagesIfAbsent([good, bad], KEY);

    await expect(write).rejects.toBeInstanceOf(RowRefusedError);
    const refusal = (await write.catch((e: unknown) => e)) as RowRefusedError;
    expect(refusal.domName).toBe('DataError');
    expect(classifyRowWriteFailure(refusal)).toBe('poison');
    // Aborted whole: the good row of the same write did not land half a batch.
    const read = await storage.getMessagesByIds('c1', ['good-row'], KEY);
    expect(read.rows.size).toBe(0);
  });
});
