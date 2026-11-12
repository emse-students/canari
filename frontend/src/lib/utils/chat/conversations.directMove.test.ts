/** The one move of a duplicate 1:1's rows (review of #3406). Group ids are fixed fakes. */
import { describe, expect, it } from 'vitest';
import { moveDirectConversationRows } from './conversations';
import type { IStorage } from '$lib/db';
import {
  messageRowStore,
  placement,
  storedRow,
} from '$lib/mls-client/test/fixtures/messageRowStore';

const OLD = '33333333-3333-4333-8333-333333333333';
const JOINED = '22222222-2222-4222-8222-222222222222';

describe('moveDirectConversationRows', () => {
  it('moves every row that opens, as stored, and counts the ones that do not', async () => {
    const store = messageRowStore([
      storedRow('a', OLD, { isEdited: true, content: 'edited' }),
      storedRow('b', OLD),
      storedRow('sealed', OLD, { unreadable: true }),
      storedRow('own', JOINED),
      storedRow('other', '99999999-9999-4999-8999-999999999999'),
    ]);
    const { moved, left } = await moveDirectConversationRows(
      OLD,
      JOINED,
      store as unknown as IStorage,
      'key'
    );

    expect(moved).toEqual(['a', 'b']);
    expect(left).toBe(1);
    expect(placement(store)).toEqual({
      a: JOINED,
      b: JOINED,
      sealed: OLD,
      own: JOINED,
      other: '99999999-9999-4999-8999-999999999999',
    });
    expect(store.byId.get('a')).toMatchObject({ content: 'edited', isEdited: true });
    // The target is never read: a message id is the store's key, so no row of OLD stands there.
    expect(store.getMessages).toHaveBeenCalledTimes(1);
    expect(store.getMessages).toHaveBeenCalledWith(OLD, 'key');
  });

  it('writes nothing when the source holds nothing', async () => {
    const store = messageRowStore([storedRow('own', JOINED)]);
    const result = await moveDirectConversationRows(OLD, JOINED, store as unknown as IStorage, 'k');
    expect(result).toEqual({ moved: [], left: 0 });
    expect(store.saveMessages).not.toHaveBeenCalled();
  });
});
