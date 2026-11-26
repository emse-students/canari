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
  const msg = (conversationId: string) => ({ id: 'm', conversationId }) as StoredMessage;

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
    await store.saveMessages([msg('g-1'), msg('g-2'), msg('g-1')], 'k');
    await store.getMessages('g-1', 'k');
    await store.clear();
    off();
    expect(seen).toEqual([['g-1', 'g-2'], 'all']);
  });

  it('announces a FAILED write too: it may have written part of its rows', async () => {
    const seen: TouchedConversations[] = [];
    const off = subscribeMessageWrites((t) => seen.push(t));
    const store = observeMessageWrites(fakeStore());
    await expect(store.updateMessage('g-9', 'm', {}, 'k')).rejects.toThrow('disk full');
    off();
    expect(seen).toEqual([['g-9']]);
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
    expect(seen).toEqual([['g-3']]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('reads properties through, the open flag included', () => {
    expect(observeMessageWrites(fakeStore()).isOpen).toBe(true);
  });
});
