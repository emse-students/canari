import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { IStorage, StoredMessage } from './types';
import {
  MESSAGE_WRITES,
  NOT_A_MESSAGE_WRITE,
  observeMessageWrites,
  subscribeMessageWrites,
  type TouchedConversations,
} from './messageWrites';

const here = dirname(fileURLToPath(import.meta.url));

/** The members `IStorage` declares, read off `types.ts` - the interface every backend implements. */
function storageMembers(): string[] {
  const src = readFileSync(resolve(here, 'types.ts'), 'utf-8');
  const start = src.indexOf('export interface IStorage {');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const names = new Set<string>();
  for (const match of body.matchAll(/^ {2}(?:readonly )?([a-zA-Z]+)[(:<]/gm)) names.add(match[1]);
  return [...names];
}

describe('every IStorage member is classified', () => {
  it('as a message write or as not one - a new write path cannot be added silently', () => {
    const members = storageMembers();
    expect(members.length).toBeGreaterThan(50);
    const classified = new Set([...Object.keys(MESSAGE_WRITES), ...NOT_A_MESSAGE_WRITE]);
    expect(members.filter((name) => !classified.has(name))).toEqual([]);
    expect([...classified].filter((name) => !members.includes(name))).toEqual([]);
  });
});

describe('observeMessageWrites', () => {
  const msg = (conversationId: string, id = 'm') => ({ id, conversationId }) as StoredMessage;

  function fakeStore() {
    return {
      isOpen: true,
      saveMessages: vi.fn(async () => {}),
      updateMessage: vi.fn(async () => {
        throw new Error('disk full');
      }),
      getMessages: vi.fn(async () => []),
      clear: vi.fn(async () => {}),
    } as unknown as IStorage;
  }

  it('announces the conversations a write named, once it settled', async () => {
    const seen: TouchedConversations[] = [];
    const off = subscribeMessageWrites((t) => seen.push(t));
    const store = observeMessageWrites(fakeStore());
    await store.saveMessages(
      [msg('g-1', 'a'), msg('g-2', 'b'), msg('g-1', 'c'), msg('g-1', 'a')],
      'k'
    );
    await store.getMessages('g-1', 'k');
    await store.clear();
    off();
    expect(seen).toEqual([
      [
        { conversationId: 'g-1', ids: ['a', 'c'] },
        { conversationId: 'g-2', ids: ['b'] },
      ],
      'all',
    ]);
  });

  it('names the ids of every write that names them, and a whole conversation when it drops one', () => {
    expect(MESSAGE_WRITES.updateMessage(['g-1', 'm', {}, 'k'])).toEqual([
      { conversationId: 'g-1', ids: ['m'] },
    ]);
    expect(MESSAGE_WRITES.mergeMessages(['g-1', ['a', 'b'], () => null, 'k'])).toEqual([
      { conversationId: 'g-1', ids: ['a', 'b'] },
    ]);
    expect(MESSAGE_WRITES.moveMessages(['g-1', 'g-2', ['a'], 'k'])).toEqual([
      { conversationId: 'g-1', ids: ['a'] },
      { conversationId: 'g-2', ids: ['a'] },
    ]);
    expect(MESSAGE_WRITES.deleteMessage(['g-1', 'm'])).toEqual([
      { conversationId: 'g-1', ids: ['m'] },
    ]);
    expect(MESSAGE_WRITES.importEncryptedRow([{ id: 'r', conversationId: 'g-3' }])).toEqual([
      { conversationId: 'g-3', ids: ['r'] },
    ]);
    expect(MESSAGE_WRITES.deleteConversation(['g-4'])).toEqual([
      { conversationId: 'g-4', ids: 'all' },
    ]);
    expect(MESSAGE_WRITES.deleteOldMessages([])).toBe('all');
  });

  it('announces a FAILED write too: it may have written part of its rows', async () => {
    const seen: TouchedConversations[] = [];
    const off = subscribeMessageWrites((t) => seen.push(t));
    const store = observeMessageWrites(fakeStore());
    await expect(store.updateMessage('g-9', 'm', {}, 'k')).rejects.toThrow('disk full');
    off();
    expect(seen).toEqual([[{ conversationId: 'g-9', ids: ['m'] }]]);
  });

  it('keeps a failing listener from hiding the write from the next one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: TouchedConversations[] = [];
    const offA = subscribeMessageWrites(() => {
      throw new Error('boom');
    });
    const offB = subscribeMessageWrites((t) => seen.push(t));
    await observeMessageWrites(fakeStore()).saveMessages([msg('g-3')], 'k');
    offA();
    offB();
    expect(seen).toEqual([[{ conversationId: 'g-3', ids: ['m'] }]]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('reads properties through, the open flag included', () => {
    expect(observeMessageWrites(fakeStore()).isOpen).toBe(true);
  });
});
