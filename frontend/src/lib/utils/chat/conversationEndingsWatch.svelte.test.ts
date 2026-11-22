// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { watchConversationEndings } from './conversationEndingsWatch.svelte';
import { confirmEnding, recordRekey, settleEndingFacts } from './endedConversations';

type Row = { id: string; lifecycle?: string };

function setup() {
  settleEndingFacts(false, new Map());
  const rows = new SvelteMap<string, Row>();
  const ended: string[] = [];
  const cleanup = $effect.root(() => {
    watchConversationEndings(
      () => ({ signedIn: true, rows: rows.values() }),
      (id) => ended.push(id)
    );
  });
  flushSync();
  return { rows, ended, cleanup };
}

describe('watchConversationEndings', () => {
  it('a row removed without confirmation, then confirmed, ends its banners with no other map write', () => {
    const { rows, ended, cleanup } = setup();
    rows.set('k', { id: 'g1' });
    flushSync();
    rows.set('k', { id: 'g1', lifecycle: 'removed' });
    flushSync();
    expect(ended).toEqual([]);
    // The Remove commit confirms a row that is already removed: no write to the list.
    confirmEnding('g1');
    flushSync();
    expect(ended).toEqual(['g1']);
    cleanup();
  });

  it('a confirmed fact is dropped once the id is seen active, so it cannot end a later miss', () => {
    const { rows, ended, cleanup } = setup();
    rows.set('k', { id: 'g1' });
    flushSync();
    confirmEnding('g1');
    flushSync();
    expect(ended).toEqual([]);
    rows.set('k', { id: 'g1', lifecycle: 'removed' });
    flushSync();
    expect(ended).toEqual([]);
    cleanup();
  });

  it('a re-key spares the old id even when the loser leaves the map after other looks', () => {
    const { rows, ended, cleanup } = setup();
    rows.set('a', { id: 'old' });
    rows.set('b', { id: 'other' });
    flushSync();
    recordRekey('old');
    rows.set('b', { id: 'other', lifecycle: 'active' });
    flushSync();
    rows.delete('a');
    flushSync();
    expect(ended).toEqual([]);
    cleanup();
  });
});
