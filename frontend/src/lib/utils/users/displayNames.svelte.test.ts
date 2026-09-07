/**
 * THE RESOLVER MUST NOT DEPEND ON ITS OWN OUTPUT.
 *
 * `userDisplayNames` first held a `$state` map, read it to carry an already-resolved name across a
 * change of list, and assigned a fresh `Map` back. That makes the effect depend on what it writes,
 * and a fresh object is always a change: Svelte re-runs it, it writes again, and the page dies with
 * `effect_update_depth_exceeded`. The application does not crash - `MainChatPage` wraps `ChatArea`
 * in a `svelte:boundary` - it renders "Impossible d'afficher cette discussion" over EVERY
 * conversation instead, which is what the local estate did on 2026-09-07 and what cost GRP two rows
 * before a screenshot said so.
 *
 * THE TEST BELOW COUNTS EFFECT RUNS RATHER THAN WAITING FOR THAT THROW, because the throw is a
 * property of the shape that is now gone and not of the behaviour worth pinning. A `SvelteMap`
 * mutated in place is reactive per KEY and a write of an unchanged value notifies nobody, so even a
 * self-read converges there instead of looping - measured, by putting the read back. What survives
 * every shape is the invariant: one change of the id list runs the effect ONCE, so one sync read per
 * id. An effect that feeds itself breaks that count long before it breaks `flushSync`.
 *
 * The carry-over that was removed was redundant anyway - `getUserDisplayNameSync` reads the module
 * cache `resolveUserDisplayName` fills - and the second test pins exactly that, so the fix cannot be
 * undone by putting the read back for the reason it was there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';

const resolveUserDisplayName = vi.fn();
const getUserDisplayNameSync = vi.fn();

vi.mock('./displayName', () => ({
  resolveUserDisplayName: (id: string) => resolveUserDisplayName(id),
  getUserDisplayNameSync: (id: string, fallback?: string) => getUserDisplayNameSync(id, fallback),
}));

const { userDisplayName, userDisplayNames } = await import('./displayNames.svelte');

let stop: (() => void) | undefined;

beforeEach(() => {
  resolveUserDisplayName.mockReset();
  getUserDisplayNameSync.mockReset();
  getUserDisplayNameSync.mockImplementation((id: string, fallback?: string) => fallback ?? id);
  resolveUserDisplayName.mockResolvedValue(null);
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe('userDisplayNames', () => {
  it('runs its effect once per change of the list, not once per name it writes', () => {
    const ids = ['a', 'b'];
    let read!: Map<string, string>;
    stop = $effect.root(() => {
      read = userDisplayNames(() => ids);
    });

    expect(() => flushSync()).not.toThrow();
    expect([...read.keys()]).toEqual(['a', 'b']);
    // TWO IDS, TWO SYNC READS, AND THAT IS THE ASSERTION. A third would mean the effect ran twice
    // for one change, which is the first observable step of an effect that depends on its own
    // output - and the last one before the count stops being finite at all.
    expect(getUserDisplayNameSync.mock.calls.length).toBe(2);
  });

  it('takes an already-known name from the shared cache, not from its own previous map', async () => {
    getUserDisplayNameSync.mockImplementation((id: string) => (id === 'a' ? 'Ada' : id));
    let read!: Map<string, string>;
    stop = $effect.root(() => {
      read = userDisplayNames(() => ['a']);
    });
    flushSync();

    expect(read.get('a')).toBe('Ada');
    // The id, and nothing else: the mock's wrapper passes a second `undefined`, so this reads the
    // argument rather than the call shape.
    expect(getUserDisplayNameSync.mock.calls.map((c) => c[0])).toContain('a');
  });

  it('ignores a resolve that answered null - not knowing is not knowing there is none', async () => {
    getUserDisplayNameSync.mockImplementation((id: string) => id);
    resolveUserDisplayName.mockResolvedValue(null);
    let read!: Map<string, string>;
    stop = $effect.root(() => {
      read = userDisplayNames(() => ['a']);
    });
    flushSync();
    await Promise.resolve();
    flushSync();

    expect(read.get('a')).toBe('a');
  });

  it('drops the entry of an id that has left the list', () => {
    let ids = $state(['a', 'b']);
    let read!: Map<string, string>;
    stop = $effect.root(() => {
      read = userDisplayNames(() => ids);
    });
    flushSync();
    expect([...read.keys()]).toEqual(['a', 'b']);

    // A panel open on a group somebody leaves must not keep resolving them for ever. Pruning is the
    // one thing that needs to know the previous keys, and asking the map for them is the loop this
    // file exists to prevent - so it is asserted here rather than left to review.
    ids = ['b'];
    expect(() => flushSync()).not.toThrow();
    expect([...read.keys()]).toEqual(['b']);
  });
});

describe('userDisplayName', () => {
  it('paints the sync answer first and upgrades it when the resolve lands', async () => {
    getUserDisplayNameSync.mockImplementation((id: string, fallback?: string) => fallback ?? id);
    resolveUserDisplayName.mockResolvedValue('Ada Lovelace');
    let read!: { current: string };
    stop = $effect.root(() => {
      read = userDisplayName(
        () => 'a',
        () => 'fallback'
      );
    });
    flushSync();
    expect(read.current).toBe('fallback');

    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(read.current).toBe('Ada Lovelace');
  });
});
