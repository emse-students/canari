/**
 * A roster that failed to load is NOT an empty roster. The editor used to catch the failure and draw
 * the association with nobody, and a publish wrote that empty list onto the live carte.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AssociationMember } from '$lib/associations/api';
import { buildPosterModel } from './generator';
import {
  loadRoster,
  loadRosters,
  loadedMembers,
  markStale,
  publishBlock,
  runUnlessBlocked,
  shownButUnlisted,
} from './rosterLoads';

const member = (userId: string) =>
  ({ userId, displayName: userId, isAdmin: false }) as unknown as AssociationMember;

describe('rosterLoads - a failed roster is a state, never an empty list', () => {
  it('marks a roster whose request fails as failed, and draws nothing for it', async () => {
    const fetch = vi.fn((id: string) =>
      id === 'a2'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve([member('u1')])
    );
    const loads = await loadRosters(['a1', 'a2'], fetch);
    expect(loads).toEqual({
      a1: { state: 'loaded', members: [member('u1')] },
      a2: { state: 'failed' },
    });
    // The model is drawn from LOADED rosters only: `a2` is absent, never `[]`.
    expect(loadedMembers(loads)).toEqual({ a1: [member('u1')] });
  });

  it('refuses to publish while a drawn roster is not loaded, names it, and lifts once a retry loads it', async () => {
    const fetch = vi
      .fn<(id: string) => Promise<AssociationMember[]>>()
      .mockResolvedValueOnce([member('u1')])
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const loads = await loadRosters(['a1', 'a2'], fetch);
    expect(publishBlock(['a1', 'a2'], loads, [])).toEqual({ rosters: ['a2'], unlisted: [] });

    fetch.mockResolvedValueOnce([member('u2')]);
    const retried = { ...loads, a2: await loadRoster('a2', fetch) };
    expect(retried.a2).toEqual({ state: 'loaded', members: [member('u2')] });
    expect(publishBlock(['a1', 'a2'], retried, [])).toBeNull();
  });

  it('allows publishing an association that is genuinely empty', async () => {
    const loads = await loadRosters(['a1'], () => Promise.resolve([]));
    expect(loads.a1).toEqual({ state: 'loaded', members: [] });
    expect(publishBlock(['a1'], loads, [])).toBeNull();
  });

  it('blocks the publish of a failed roster even though the model draws it with an empty member list', async () => {
    const loads = await loadRosters(['a1'], () => Promise.reject(new Error('503')));
    const asso = { id: 'a1', name: 'A1', type: 'association', archived: false } as never;
    // Drawn from what loaded, the association has no roster entry at all - and publishBlock, not an
    // empty array, is what the editor reads to decide.
    const model = buildPosterModel([asso], [], {}, loadedMembers(loads), 'Z');
    expect(model.zones[0].bubbles[0].members).toEqual([]);
    expect(publishBlock(['a1'], loads, [])).toEqual({ rosters: ['a1'], unlisted: [] });
  });

  it('blocks on a shown association the catalogue did not list, and ignores one switched off', () => {
    const unlisted = shownButUnlisted(new Set(['a1', 'a3']), ['a1', 'a2', 'a3'], new Set(['a1']));
    expect(unlisted).toEqual(['a3']);
    expect(publishBlock([], {}, unlisted)).toEqual({ rosters: [], unlisted: ['a3'] });
  });

  it('fails a roster whose answer is not a list, instead of drawing it empty', async () => {
    const load = await loadRoster('a1', () => Promise.resolve({} as never));
    expect(load).toEqual({ state: 'failed' });
    expect(publishBlock(['a1'], { a1: load }, [])).toEqual({ rosters: ['a1'], unlisted: [] });
  });

  it('leaves a review account out of a roster: no public map carries one', async () => {
    const review = { ...member('rev'), reviewAccount: true } as AssociationMember;
    const load = await loadRoster('a1', () => Promise.resolve([member('u1'), review]));
    expect(load).toEqual({ state: 'loaded', members: [member('u1')] });
  });

  it('marks the rosters the server called stale, which blocks until they are re-read', async () => {
    const loads = await loadRosters(['a1', 'a2'], () => Promise.resolve([member('u1')]));
    const stale = markStale(loads, ['a2']);
    expect(stale.a2).toEqual({ state: 'stale' });
    expect(publishBlock(['a1', 'a2'], stale, [])).toEqual({ rosters: ['a2'], unlisted: [] });
  });
});

describe('runUnlessBlocked - the one gate in front of a publish and an export', () => {
  it('does not run the action while something blocks, and says what blocks', async () => {
    const act = vi.fn(() => Promise.resolve());
    const onRefused = vi.fn();
    const loads = await loadRosters(['a1'], () => Promise.reject(new TypeError('Failed to fetch')));
    const ran = await runUnlessBlocked(publishBlock(['a1'], loads, []), onRefused, act);
    expect(ran).toBe(false);
    expect(act).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith({ rosters: ['a1'], unlisted: [] });
  });

  it('runs the action when every drawn roster is loaded, an empty one included', async () => {
    const act = vi.fn(() => Promise.resolve());
    const onRefused = vi.fn();
    const loads = await loadRosters(['a1'], () => Promise.resolve([]));
    const ran = await runUnlessBlocked(publishBlock(['a1'], loads, []), onRefused, act);
    expect(ran).toBe(true);
    expect(act).toHaveBeenCalledTimes(1);
    expect(onRefused).not.toHaveBeenCalled();
  });
});
