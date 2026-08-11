/**
 * `retireConversation` is the ONLY writer of `lifecycle: 'removed'`, and this file defends both
 * halves of that claim.
 *
 * The first fix for WP-HISTGHOST-1 wired the awaiting-history cleanup into
 * `markConversationDeletedRemotely` and shipped. It was verified against production and FAILED:
 * the deletion had reached the peer (the row was `removed`) while the marker survived with its
 * original timestamp, because the path that actually ran was the `groupDeleted` system-message
 * handler - one of FIVE places that wrote the state inline. Enumerating the callers of a helper is
 * not enumerating the writers of a state, so the last test here reads the source and refuses a
 * sixth writer.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import {
  retireConversation,
  purgeConversation,
  markConversationDeletedRemotely,
} from './conversations';
import { markAwaitingHistory, isAwaitingHistory } from './awaitingHistoryRegistry';

const USER = 'user-a';
const GROUP = 'group-1';

const makeConvo = (over: Partial<Conversation> = {}): Conversation =>
  ({ id: GROUP, name: 'G', messages: [], ...over }) as unknown as Conversation;

describe('retireConversation', () => {
  beforeEach(() => localStorage.clear());

  it('marks the row removed and forgets the awaiting-history marker', async () => {
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo()]]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    const changed = await retireConversation({
      conversations,
      key: 'k',
      groupId: GROUP,
      userId: USER,
    });

    expect(changed).toBe(true);
    expect(conversations.get('k')?.lifecycle).toBe('removed');
    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });

  it('forgets the marker even when persisting the row rejects', async () => {
    // The forget must not be downstream of the save: a rejected write would otherwise leave the
    // conversation retired in memory and the marker soliciting for ever.
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo()]]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    await retireConversation({
      conversations,
      key: 'k',
      groupId: GROUP,
      userId: USER,
      saveConversation: () => Promise.reject(new Error('quota')),
    });

    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });

  it('is a no-op on a row that is already retired', async () => {
    const conversations = new SvelteMap<string, Conversation>([
      ['k', makeConvo({ lifecycle: 'removed' })],
    ]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    expect(
      await retireConversation({ conversations, key: 'k', groupId: GROUP, userId: USER })
    ).toBe(false);
    // An early return has no side effects: another path may still be working on this marker.
    expect(isAwaitingHistory(USER, GROUP)).toBe(true);
  });

  it('is a no-op when the row does not exist', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    expect(
      await retireConversation({ conversations, key: 'k', groupId: GROUP, userId: USER })
    ).toBe(false);
  });

  it('merges a patch while still retiring the row', async () => {
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo({ id: 'stale' })]]);
    await retireConversation({
      conversations,
      key: 'k',
      groupId: GROUP,
      userId: USER,
      patch: { id: GROUP },
    });
    expect(conversations.get('k')?.id).toBe(GROUP);
    expect(conversations.get('k')?.lifecycle).toBe('removed');
  });

  it('markConversationDeletedRemotely finds the row by group id and retires it', async () => {
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo()]]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    expect(markConversationDeletedRemotely(conversations, GROUP, USER)).toBe(true);
    expect(conversations.get('k')?.lifecycle).toBe('removed');
    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });
});

describe('purgeConversation', () => {
  beforeEach(() => localStorage.clear());

  it('removes the row and forgets the awaiting-history marker', async () => {
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo()]]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    expect(await purgeConversation({ conversations, key: 'k', groupId: GROUP, userId: USER })).toBe(
      true
    );
    expect(conversations.has('k')).toBe(false);
    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });

  it("falls back to the row's own group id when the caller does not pass one", async () => {
    // The two exits reach this with different information: the system-message handler holds the
    // group id, the UI handler holds only the map key.
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo()]]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    await purgeConversation({ conversations, key: 'k', userId: USER });

    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });

  it('forgets the marker even when deleting the stored row rejects', async () => {
    // Same ordering rule as retiring: a failed write must not be able to strand the marker.
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo()]]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    await purgeConversation({
      conversations,
      key: 'k',
      groupId: GROUP,
      userId: USER,
      deleteStored: () => Promise.reject(new Error('quota')),
    });

    expect(conversations.has('k')).toBe(false);
    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });

  it('reports false when there was no row to remove', async () => {
    const conversations = new SvelteMap<string, Conversation>();
    expect(await purgeConversation({ conversations, key: 'k', groupId: GROUP, userId: USER })).toBe(
      false
    );
  });
});

describe('the single-writer invariant', () => {
  /** Every `.ts`/`.svelte` file under `src`, minus this file. */
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'paraglide' && entry.name !== 'node_modules') sourceFiles(full, acc);
      } else if (/\.(ts|svelte)$/.test(entry.name)) {
        acc.push(full);
      }
    }
    return acc;
  }

  /**
   * The file with its comments removed.
   *
   * Without this the check fails on the prose that EXPLAINS the invariant - the docblocks in
   * `historySolicit.ts` quote `lifecycle: 'removed'` to say why the banner outlived its
   * conversation. A guard that punishes the documentation of the rule it enforces is a guard
   * people delete.
   */
  const codeOnly = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('only conversations.ts writes lifecycle: removed', () => {
    // A grep, deliberately: no unit test can observe a path that has not been wired up yet, and
    // the defect this guards against is precisely a NEW path written inline by someone who never
    // saw `retireConversation`. Test files are exempt - they build fixtures in that state.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      if (file.endsWith('.test.ts')) continue;
      if (file.endsWith(join('utils', 'chat', 'conversations.ts'))) continue;
      const text = codeOnly(readFileSync(file, 'utf8'));
      if (/lifecycle:\s*'removed'|lifecycle\s*=\s*'removed'/.test(text)) {
        offenders.push(file.replace(process.cwd(), ''));
      }
    }
    expect(
      offenders,
      'these files retire a conversation inline - call retireConversation instead'
    ).toEqual([]);
  });
});
