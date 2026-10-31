// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hideUnopenable,
  isHiddenFromList,
  isUnopenableHere,
  loadHiddenUnopenable,
  noteNoHolderReading,
  parseNoHolderFacts,
  parseSeat,
  readNoHolder,
  resetNoHolderReadings,
} from './noHolder.svelte';
import type { NoHolderFacts } from '$lib/mls-client/IMlsService';

/**
 * D5 of docs/wiki/protocols/mls-availability-no-holder.md: "this conversation cannot be opened on
 * this device" is said on the WHOLE fact set of one server answer, and on nothing less.
 */
describe('readNoHolder', () => {
  const nothingOnItsWay = { status: 'pending', welcomeQueued: false, addInFlight: false } as const;
  const stale = { baseEpoch: 3, activeEpoch: 5 };

  it('says no-holder only for an unusable base, nothing on its way and a no_peer_online answer', () => {
    expect(readNoHolder({ base: stale, seat: nothingOnItsWay })).toBe('no-holder');
    expect(readNoHolder({ base: null, seat: nothingOnItsWay })).toBe('no-holder');
    expect(readNoHolder({ base: null, seat: { status: 'none' } })).toBe('no-holder');
  });

  it('reads the BASE first: a current base is a door this device opens itself, whatever the seat', () => {
    const current = { baseEpoch: 5, activeEpoch: 5 };
    expect(readNoHolder({ base: current, seat: nothingOnItsWay })).toBe('base-usable');
    expect(readNoHolder({ base: current, seat: { status: 'pending', welcomeQueued: false } })).toBe(
      'base-usable'
    );
  });

  it.each<[string, NoHolderFacts | undefined, string]>([
    ['no facts', undefined, 'unknown'],
    [
      'a queued Welcome',
      { base: stale, seat: { status: 'pending', welcomeQueued: true, addInFlight: false } },
      'welcome-owed',
    ],
    [
      'an Add in flight',
      { base: null, seat: { status: 'pending', welcomeQueued: false, addInFlight: true } },
      'welcome-owed',
    ],
    [
      'an unread add lock',
      { base: null, seat: { status: 'pending', welcomeQueued: false } },
      'unknown',
    ],
    ['an active seat', { base: stale, seat: { status: 'active' } }, 'unknown'],
  ])('never says no-holder for %s', (_label, facts, expected) => {
    expect(readNoHolder(facts)).toBe(expected);
  });
});

describe('parseNoHolderFacts', () => {
  it('reads the served shape', () => {
    expect(
      parseNoHolderFacts({
        base: { baseEpoch: 1, activeEpoch: 2 },
        seat: { status: 'pending', welcomeQueued: false, addInFlight: false },
      })
    ).toEqual({
      base: { baseEpoch: 1, activeEpoch: 2 },
      seat: { status: 'pending', welcomeQueued: false, addInFlight: false },
    });
    expect(parseNoHolderFacts({ base: null, seat: { status: 'none' } })).toEqual({
      base: null,
      seat: { status: 'none' },
    });
  });

  it('refuses anything else, so a malformed answer is unknown, never a dead end', () => {
    expect(parseNoHolderFacts(undefined)).toBeUndefined();
    expect(parseNoHolderFacts({ seat: { status: 'none' } })).toBeUndefined();
    expect(
      parseNoHolderFacts({ base: { baseEpoch: 1 }, seat: { status: 'none' } })
    ).toBeUndefined();
    expect(parseNoHolderFacts({ base: null, seat: { status: 'pending' } })).toBeUndefined();
    expect(parseSeat({ status: 'weird' })).toBeUndefined();
  });
});

describe('the banner and the list', () => {
  beforeEach(() => {
    resetNoHolderReadings();
    localStorage.clear();
  });

  it('is raised by a no-holder reading and taken down by any other', () => {
    const log = vi.fn();
    noteNoHolderReading('g1', 'no-holder', log);
    expect(isUnopenableHere('g1')).toBe(true);
    noteNoHolderReading('g1', 'unknown', log);
    expect(isUnopenableHere('g1')).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('hides a conversation only while it is not active, and remembers it per account', () => {
    hideUnopenable('user-a', 'g1');
    expect(isHiddenFromList('g1', 'pending')).toBe(true);
    // A device that held it came back and added this one: it is listed again.
    expect(isHiddenFromList('g1', 'active')).toBe(false);

    loadHiddenUnopenable('user-b');
    expect(isHiddenFromList('g1', 'pending')).toBe(false);
    loadHiddenUnopenable('user-a');
    expect(isHiddenFromList('g1', 'pending')).toBe(true);
  });
});
