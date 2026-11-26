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
  const source: MessageIndexSource = {
    conversationIds: async () => [...store.keys()],
    readMessages: async (id) => {
      reads.push(id);
      return store.get(id) ?? [];
    },
  };
  return { source, reads };
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

  it('re-reads ONLY the conversation a store write named, and tells its owner', async () => {
    const store = new Map([
      ['g-1', [row('g-1', 'a', text('avant'), 10)]],
      ['g-2', [row('g-2', 'b', text('rien'), 20)]],
    ]);
    const { source, reads } = fakeSource(store);
    const changed = vi.fn();
    const index = new LocalMessageIndex(source, () => {}, changed);
    await index.refresh();
    // A write through the real seam every store write crosses.
    const raw = {
      updateMessage: async () => {
        store.set('g-1', [row('g-1', 'a', text('après la modification'), 10)]);
      },
    } as unknown as IStorage;
    await observeMessageWrites(raw).updateMessage('g-1', 'a', {}, 'k');
    expect(changed).toHaveBeenCalledOnce();
    await index.refresh();
    expect(reads).toEqual(['g-1', 'g-2', 'g-1']);
    expect(index.search(foldQuery('avant'), 5).total).toBe(0);
    expect(index.search(foldQuery('modification'), 5).total).toBe(1);
    index.discard();
  });

  it('keeps a conversation written DURING its read marked, so the next refresh reads it again', async () => {
    const store = new Map([['g-1', [row('g-1', 'a', text('un'), 10)]]]);
    let index: LocalMessageIndex | null = null;
    const reads: string[] = [];
    const source: MessageIndexSource = {
      conversationIds: async () => ['g-1'],
      readMessages: async (id) => {
        reads.push(id);
        if (reads.length === 1) index?.noteWrite([id]);
        return store.get(id) ?? [];
      },
    };
    index = new LocalMessageIndex(source, () => {});
    await index.refresh();
    await index.refresh();
    await index.refresh();
    expect(reads).toEqual(['g-1', 'g-1']);
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
    await index.refresh();
    expect(reads).toEqual(['g-1', 'g-2', 'g-1']);
    index.discard();
  });

  it('logs a conversation it could not read and reads it again next time', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const source: MessageIndexSource = {
      conversationIds: async () => ['g-1'],
      readMessages: async () => {
        if (fail) throw new Error('locked');
        return [row('g-1', 'a', text('enfin'), 1)];
      },
    };
    const index = new LocalMessageIndex(source, () => {});
    await index.refresh();
    expect(error).toHaveBeenCalledOnce();
    fail = false;
    await index.refresh();
    expect(index.search(foldQuery('enfin'), 5).total).toBe(1);
    index.discard();
    error.mockRestore();
  });
});

describe('the one index of the realm', () => {
  it('is shared while open and forgets every message when discarded', async () => {
    const store = new Map([['g-1', [row('g-1', 'a', text('secret'), 1)]]]);
    const { source } = fakeSource(store);
    const index = openLocalMessageIndex(source, () => {});
    expect(openLocalMessageIndex(source, () => {})).toBe(index);
    await index.refresh();
    expect(index.size).toBe(1);
    expect(discardLocalMessageIndex('signed out')).toBe(true);
    expect(index.size).toBe(0);
    expect(index.search(foldQuery('secret'), 5).total).toBe(0);
    expect(openIndex()).toBeNull();
    expect(discardLocalMessageIndex('again')).toBe(false);
  });

  it('stops listening to the store once discarded', async () => {
    const changed = vi.fn();
    const index = openLocalMessageIndex(fakeSource(new Map()).source, () => {}, changed);
    discardLocalMessageIndex('search closed');
    const raw = { deleteMessage: async () => {} } as unknown as IStorage;
    await observeMessageWrites(raw).deleteMessage('g-1', 'a');
    expect(changed).not.toHaveBeenCalled();
    expect(index.isDiscarded).toBe(true);
  });
});
