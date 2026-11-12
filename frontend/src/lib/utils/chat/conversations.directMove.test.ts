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
    expect(result).toEqual({ moved: [], left: 0, carried: [] });
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it('carries the mutations waiting under the old group to the joined one', async () => {
    const store = messageRowStore([storedRow('a', OLD)]);
    const waiting = (messageId: string, conversationId: string) => ({
      conversationId,
      messageId,
      sender: 'peer-user',
      kind: 'delete' as const,
      slot: '',
      rank: 0,
      at: 1_000,
    });
    // One for a moved row, one for a message neither group holds yet, one of another group.
    await store.putPendingMutation(waiting('a', OLD));
    await store.putPendingMutation(waiting('later', OLD));
    await store.putPendingMutation(waiting('x', 'other-group'));

    const { carried } = await moveDirectConversationRows(
      OLD,
      JOINED,
      store as unknown as IStorage,
      'k'
    );

    expect(carried.sort()).toEqual(['a', 'later']);
    expect(
      [...store.pending.values()].map((e) => `${e.conversationId}:${e.messageId}`).sort()
    ).toEqual([`${JOINED}:a`, `${JOINED}:later`, 'other-group:x'].sort());
  });
});
