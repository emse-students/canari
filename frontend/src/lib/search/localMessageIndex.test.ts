import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IStorage, StoredMessage } from '$lib/db/types';
import { serializeEnvelope } from '$lib/envelope';
import { observeMessageWrites } from '$lib/db/messageWrites';
import { foldQuery } from './rank';
import {
  LocalMessageIndex,
  discardLocalMessageIndex,
  indexableText,
  openLocalMessageIndex,
  type MessageIndexSource,
} from './localMessageIndex';
import { openIndex } from './localIndexRegistry';

/**
 * The universal search's local message index: built from the device's store through its decrypting
 * reads, held in memory only, kept true by the store's own writes (never a clock), and wiped at
 * sign-out. `auth.searchIndex.test.ts` holds the sign-out half end to end.
 */
const text = (s: string) => serializeEnvelope({ kind: 'text', text: s });

function row(conversationId: string, id: string, content: string, timestamp: number) {
  return { id, conversationId, senderId: 'u-a', content, timestamp } as StoredMessage;
}

function fakeSource(store: Map<string, StoredMessage[]>) {
  const reads: string[] = [];
  const idReads: string[] = [];
  const source: MessageIndexSource = {
    conversationIds: async () => [...store.keys()],
    readMessages: async (id) => {
      reads.push(id);
      return store.get(id) ?? [];
    },
    readMessagesByIds: async (id, ids) => {
      idReads.push(`${id}:${ids.join(',')}`);
      return (store.get(id) ?? []).filter((m) => ids.includes(m.id));
    },
  };
  return { source, reads, idReads };
}

/** Lets the passes a write started run to their end. */
async function settle(index: LocalMessageIndex): Promise<void> {
  await index.refresh();
  await Promise.resolve();
}

afterEach(() => {
  discardLocalMessageIndex('test teardown');
});

describe('indexableText', () => {
  it('keeps what a reader wrote and drops what the app drew', () => {
    expect(indexableText(row('g', '1', text('Le gala'), 1))).toBe('Le gala');
    expect(indexableText({ ...row('g', '1', text('Le gala'), 1), isDeleted: true })).toBeNull();
    expect(
      indexableText(row('g', '1', serializeEnvelope({ kind: 'system', text: 'A a ajouté B' }), 1))
    ).toBeNull();
    expect(
      indexableText(
        row(
          'g',
          '1',
          serializeEnvelope({
            kind: 'poll',
            question: 'Quel jour ?',
            options: [
              { id: 'a', label: 'lundi' },
              { id: 'b', label: 'mardi' },
            ],
            multipleChoice: false,
            endsAt: null,
          }),
          1
        )
      )
    ).toBe('Quel jour ?');
  });
});

describe('LocalMessageIndex', () => {
  it('reads each conversation once and answers every typed word, newest first', async () => {
    const store = new Map([
      ['g-1', [row('g-1', 'a', text('Réunion budget lundi'), 10), row('g-1', 'b', text('ok'), 20)]],
      ['g-2', [row('g-2', 'c', text('le budget de la réunion'), 30)]],
    ]);
    const { source, reads } = fakeSource(store);
    const index = new LocalMessageIndex(source, () => {});
    await index.refresh();
    await index.refresh();
    expect(reads).toEqual(['g-1', 'g-2']);
    const found = index.search(foldQuery('reunion BUDGET'), 10);
    expect(found.hits.map((h) => h.id)).toEqual(['c', 'a']);
    expect(found.total).toBe(2);
    expect(index.search(foldQuery('reunion'), 1)).toMatchObject({ total: 2 });
    index.discard();
  });

  it('re-reads ONLY the rows a store write named - never the whole conversation', async () => {
    const store = new Map([
      ['g-1', [row('g-1', 'a', text('avant'), 10), row('g-1', 'z', text('ancien'), 5)]],
      ['g-2', [row('g-2', 'b', text('rien'), 20)]],
    ]);
    const { source, reads, idReads } = fakeSource(store);
    const changed = vi.fn();
    const index = new LocalMessageIndex(source, () => {}, changed);
    await index.refresh();
    // After the first conversation, then once at the end.
    expect(changed).toHaveBeenCalledTimes(2);
    // A write through the real seam every store write crosses starts the pass that reads it.
    const raw = {
      updateMessage: async () => {
        store.set('g-1', [
          row('g-1', 'a', text('après la modification'), 10),
          row('g-1', 'z', text('ancien'), 5),
        ]);
      },
    } as unknown as IStorage;
    await observeMessageWrites(raw).updateMessage('g-1', 'a', {}, 'k');
    expect(index.filling).toBe(true);
    await settle(index);
    expect(reads).toEqual(['g-1', 'g-2']);
    expect(idReads).toEqual(['g-1:a']);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(index.filling).toBe(false);
    expect(index.search(foldQuery('avant'), 5).total).toBe(0);
    expect(index.search(foldQuery('modification'), 5).total).toBe(1);
    expect(index.search(foldQuery('ancien'), 5).total).toBe(1);
    index.discard();
  });

  it('forgets a message deleted after it was read', async () => {
    const store = new Map([['g-1', [row('g-1', 'a', text('secret effacé'), 10)]]]);
    const { source } = fakeSource(store);
    const index = new LocalMessageIndex(source, () => {});
    await index.refresh();
    expect(index.search(foldQuery('secret'), 5).total).toBe(1);
    const raw = {
      deleteMessage: async () => {
        store.set('g-1', []);
      },
    } as unknown as IStorage;
    await observeMessageWrites(raw).deleteMessage('g-1', 'a');
    await settle(index);
    expect(index.search(foldQuery('secret'), 5).total).toBe(0);
    index.discard();
  });

  it('reads a write landing DURING a pass in the next pass, before the refresh resolves', async () => {
    const store = new Map([['g-1', [row('g-1', 'a', text('un'), 10)]]]);
    let index: LocalMessageIndex | null = null;
    const reads: string[] = [];
    const source: MessageIndexSource = {
      conversationIds: async () => ['g-1'],
      readMessages: async (id) => {
        reads.push(id);
        if (reads.length === 1) {
          store.set('g-1', [row('g-1', 'a', text('un'), 10), row('g-1', 'b', text('deux'), 11)]);
          index?.noteWrite([{ conversationId: id, ids: ['b'] }]);
        }
        return store.get(id) ?? [];
      },
      readMessagesByIds: async (id, ids) => {
        reads.push(`${id}:${ids.join(',')}`);
        return (store.get(id) ?? []).filter((m) => ids.includes(m.id));
      },
    };
    index = new LocalMessageIndex(source, () => {});
    await index.refresh();
    expect(reads).toEqual(['g-1', 'g-1:b']);
    expect(index.search(foldQuery('deux'), 5).total).toBe(1);
    await index.refresh();
    expect(reads).toHaveLength(2);
    index.discard();
  });

  it('forgets a conversation no longer covered, and reads everything again after a clear', async () => {
    const store = new Map([
      ['g-1', [row('g-1', 'a', text('mot'), 10)]],
      ['g-2', [row('g-2', 'b', text('mot'), 20)]],
    ]);
    const { source, reads } = fakeSource(store);
    const index = new LocalMessageIndex(source, () => {});
    await index.refresh();
    store.delete('g-2');
    await index.refresh();
    expect(index.search(foldQuery('mot'), 5).total).toBe(1);
    index.noteWrite('all');
    await settle(index);
    expect(reads).toEqual(['g-1', 'g-2', 'g-1']);
    index.discard();
  });

  it('a conversation whose read failed shows none of its messages, and a write retries it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = false;
    const store = new Map([['g-1', [row('g-1', 'a', text('enfin'), 1)]]]);
    const source: MessageIndexSource = {
      conversationIds: async () => ['g-1'],
      readMessages: async (id) => {
        if (fail) throw new Error('locked');
        return store.get(id) ?? [];
      },
      readMessagesByIds: async () => {
        if (fail) throw new Error('locked');
        return [];
      },
    };
    const index = new LocalMessageIndex(source, () => {});
    await index.refresh();
    fail = true;
    // The read that would have said whether the row is still there failed: nothing of it is shown.
    index.noteWrite([{ conversationId: 'g-1', ids: ['a'] }]);
    await settle(index);
    expect(error).toHaveBeenCalledOnce();
    expect(index.search(foldQuery('enfin'), 5).total).toBe(0);
    // A failed conversation does not keep the index filling (no loop of passes over it)...
    expect(index.wants(['g-1'])).toBe(false);
    expect(index.filling).toBe(false);
    // ...and the next write reads it whole again.
    fail = false;
    index.noteWrite([{ conversationId: 'g-1', ids: ['b'] }]);
    await settle(index);
    expect(index.search(foldQuery('enfin'), 5).total).toBe(1);
    index.discard();
    error.mockRestore();
  });

  it('tells the search as it fills: after 1, 2, 4... conversations, then once at the end', async () => {
    const ids = ['g-1', 'g-2', 'g-3', 'g-4', 'g-5', 'g-6'];
    const store = new Map(ids.map((id) => [id, [row(id, `${id}-m`, text('mot'), 1)]]));
    const seen: number[] = [];
    let index: LocalMessageIndex | null = null;
    index = new LocalMessageIndex(
      fakeSource(store).source,
      () => {},
      () => seen.push(index!.size)
    );
    expect(index.filling).toBe(true);
    index.search(foldQuery('mot'), 5);
    await index.refresh();
    expect(seen).toEqual([1, 2, 4, 6]);
    expect(index.filling).toBe(false);
    index.discard();
  });

  it('owes the search the last word when it answered while filling, even if nothing changed', async () => {
    const changed = vi.fn();
    const index = new LocalMessageIndex(fakeSource(new Map()).source, () => {}, changed);
    index.search(foldQuery('mot'), 5);
    await index.refresh();
    expect(changed).toHaveBeenCalledOnce();
    expect(index.filling).toBe(false);
    // Answered once it is full: no further word, so a re-run never loops.
    index.search(foldQuery('mot'), 5);
    await index.refresh();
    expect(changed).toHaveBeenCalledOnce();
    index.discard();
  });
});

describe('the one index of the realm', () => {
  it('is shared while open and forgets every message when discarded', async () => {
    const store = new Map([['g-1', [row('g-1', 'a', text('secret'), 1)]]]);
    const { source } = fakeSource(store);
    const index = openLocalMessageIndex('u-1', source, () => {});
    expect(openLocalMessageIndex('u-1', source, () => {})).toBe(index);
    await index.refresh();
    expect(index.size).toBe(1);
    expect(discardLocalMessageIndex('signed out')).toBe(true);
    expect(index.size).toBe(0);
    expect(index.search(foldQuery('secret'), 5).total).toBe(0);
    expect(openIndex('u-1')).toBeNull();
    expect(discardLocalMessageIndex('again')).toBe(false);
  });

  it('stops listening to the store once discarded', async () => {
    const changed = vi.fn();
    const index = openLocalMessageIndex('u-1', fakeSource(new Map()).source, () => {}, changed);
    await index.refresh();
    changed.mockClear();
    discardLocalMessageIndex('search closed');
    const raw = { deleteMessage: async () => {} } as unknown as IStorage;
    await observeMessageWrites(raw).deleteMessage('g-1', 'a');
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(index.isDiscarded).toBe(true);
  });

  it('is never handed to another account: the one held is discarded', async () => {
    const store = new Map([['g-1', [row('g-1', 'a', text('secret'), 1)]]]);
    const first = openLocalMessageIndex('u-1', fakeSource(store).source, () => {});
    await first.refresh();
    const second = openLocalMessageIndex('u-2', fakeSource(new Map()).source, () => {});
    expect(second).not.toBe(first);
    expect(first.isDiscarded).toBe(true);
    expect(first.size).toBe(0);
    expect(second.search(foldQuery('secret'), 5).total).toBe(0);
  });
});
