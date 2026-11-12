/**
 * The one move of a duplicate 1:1's rows, and the boot merge that must not undo a Welcome's re-key
 * (review of #3406). Group ids are fixed fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { mergeDirectConversationDuplicates, moveDirectConversationRows } from './conversations';
import type { ConversationMeta, IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import {
  messageRowStore,
  placement,
  storedRow,
} from '$lib/mls-client/test/fixtures/messageRowStore';

const ME = 'aaaa0000-0000-0000-0000-000000000000';
const PEER = 'bbbb0000-0000-0000-0000-000000000000';
const OLD = '33333333-3333-4333-8333-333333333333';
const JOINED = '22222222-2222-4222-8222-222222222222';
const NAME = `${ME}::${PEER}`;

function meta(id: string, updatedAt: number): ConversationMeta {
  return { id, name: NAME, lifecycle: 'active', updatedAt } as ConversationMeta;
}

function mls(localGroups: string[]) {
  return {
    getLocalGroups: vi.fn(() => localGroups),
    getGroupMeta: vi.fn().mockResolvedValue(null),
    deleteGroupOnServer: vi.fn().mockResolvedValue(undefined),
  } as unknown as IMlsService & { deleteGroupOnServer: ReturnType<typeof vi.fn> };
}

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

describe('the boot merge keeps the conversation whose group this device holds', () => {
  it('a crash mid-move: the newer duplicate whose group is gone is folded INTO the live one', async () => {
    // The Welcome saved JOINED's row, moved part of the history, and stopped. OLD's row is newer,
    // and OLD's MLS state was forgotten when the peer's merge tombstoned it.
    const store = messageRowStore([storedRow('moved', JOINED), storedRow('leftover', OLD)]);
    const service = mls([JOINED]);
    const log = vi.fn();
    const result = await mergeDirectConversationDuplicates(
      [meta(JOINED, 1000), meta(OLD, 2000)],
      ME,
      'key',
      store as unknown as IStorage,
      log,
      service
    );

    expect(result.map((m) => m.id)).toEqual([JOINED]);
    expect(placement(store)).toEqual({ moved: JOINED, leftover: JOINED });
    expect(store.deleteConversation).toHaveBeenCalledWith(OLD);
    expect(store.deleteConversation).not.toHaveBeenCalledWith(JOINED);
    expect(service.deleteGroupOnServer).toHaveBeenCalledWith(OLD);
    expect(service.deleteGroupOnServer).not.toHaveBeenCalledWith(JOINED);
    expect(log.mock.calls.some((c) => String(c[0]).includes('[DM_MERGE] keeping 22222222'))).toBe(
      true
    );
  });

  it('control: with both groups held (or neither), the most recent is kept as before', async () => {
    for (const held of [[JOINED, OLD], []]) {
      const store = messageRowStore([storedRow('x', JOINED), storedRow('y', OLD)]);
      const result = await mergeDirectConversationDuplicates(
        [meta(JOINED, 1000), meta(OLD, 2000)],
        ME,
        'key',
        store as unknown as IStorage,
        () => {},
        mls(held)
      );
      expect(result.map((m) => m.id)).toEqual([OLD]);
      expect(placement(store)).toEqual({ x: OLD, y: OLD });
    }
  });
});
