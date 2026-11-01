// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HIDDEN_UNOPENABLE_CAP,
  hideUnopenable,
  isHiddenFromList,
  isUnopenableHere,
  loadHiddenUnopenable,
  noteNoHolderReading,
  parseNoHolderFacts,
  parseSeat,
  readNoHolder,
  releaseHiddenOnceActive,
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
  /** No other user's device holds it and is alive, and no wake went out. */
  const GONE = { liveHolderDevices: 0, wakeSent: false };

  it('says no-holder only for an unusable base, nothing on its way and a no_peer_online answer', () => {
    expect(readNoHolder({ base: stale, seat: nothingOnItsWay, holders: GONE })).toBe('no-holder');
    expect(readNoHolder({ base: null, seat: nothingOnItsWay, holders: GONE })).toBe('no-holder');
    expect(readNoHolder({ base: null, seat: { status: 'none' }, holders: GONE })).toBe('no-holder');
  });

  it('reads the BASE first: a current base is a door this device opens itself, whatever the seat', () => {
    const current = { baseEpoch: 5, activeEpoch: 5 };
    expect(readNoHolder({ base: current, seat: nothingOnItsWay, holders: GONE })).toBe(
      'base-usable'
    );
    expect(
      readNoHolder({
        base: current,
        seat: { status: 'pending', welcomeQueued: false },
        holders: GONE,
      })
    ).toBe('base-usable');
  });

  it.each<[string, NoHolderFacts | undefined, string]>([
    ['no facts', undefined, 'unknown'],
    [
      'a queued Welcome',
      {
        base: stale,
        seat: { status: 'pending', welcomeQueued: true, addInFlight: false },
        holders: GONE,
      },
      'welcome-owed',
    ],
    [
      'an Add in flight',
      {
        base: null,
        seat: { status: 'pending', welcomeQueued: false, addInFlight: true },
        holders: GONE,
      },
      'welcome-owed',
    ],
    [
      'an unread add lock',
      { base: null, seat: { status: 'pending', welcomeQueued: false }, holders: GONE },
      'unknown',
    ],
    ['an active seat', { base: stale, seat: { status: 'active' }, holders: GONE }, 'unknown'],
    [
      'a member who still holds it and is alive - a slow group, not a dead one',
      { base: stale, seat: nothingOnItsWay, holders: { liveHolderDevices: 1, wakeSent: false } },
      'unknown',
    ],
    [
      'a wake this answer sent to member phones',
      { base: null, seat: nothingOnItsWay, holders: { liveHolderDevices: 0, wakeSent: true } },
      'unknown',
    ],
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
        holders: { liveHolderDevices: 2, wakeSent: true },
      })
    ).toEqual({
      base: { baseEpoch: 1, activeEpoch: 2 },
      seat: { status: 'pending', welcomeQueued: false, addInFlight: false },
      holders: { liveHolderDevices: 2, wakeSent: true },
    });
    expect(
      parseNoHolderFacts({
        base: null,
        seat: { status: 'none' },
        holders: { liveHolderDevices: 0, wakeSent: false },
      })
    ).toEqual({
      base: null,
      seat: { status: 'none' },
      holders: { liveHolderDevices: 0, wakeSent: false },
    });
  });

  it('refuses anything else, so a malformed answer is unknown, never a dead end', () => {
    expect(parseNoHolderFacts(undefined)).toBeUndefined();
    expect(parseNoHolderFacts({ seat: { status: 'none' } })).toBeUndefined();
    expect(
      parseNoHolderFacts({ base: { baseEpoch: 1 }, seat: { status: 'none' } })
    ).toBeUndefined();
    expect(parseNoHolderFacts({ base: null, seat: { status: 'pending' } })).toBeUndefined();
    // A server that does not say whether a member could still answer (an older one) is unknown.
    expect(parseNoHolderFacts({ base: null, seat: { status: 'none' } })).toBeUndefined();
    expect(
      parseNoHolderFacts({
        base: null,
        seat: { status: 'none' },
        holders: { liveHolderDevices: -1, wakeSent: false },
      })
    ).toBeUndefined();
    expect(
      parseNoHolderFacts({
        base: null,
        seat: { status: 'none' },
        holders: { liveHolderDevices: 0 },
      })
    ).toBeUndefined();
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

  it('releases a hidden conversation the first time it is seen active, so a later pending state never hides it', () => {
    hideUnopenable('user-r', 'g-live');
    releaseHiddenOnceActive('g-live');
    expect(isHiddenFromList('g-live', 'pending')).toBe(false);
    // And it stays released across a reload of the account's list.
    loadHiddenUnopenable('user-other');
    loadHiddenUnopenable('user-r');
    expect(isHiddenFromList('g-live', 'pending')).toBe(false);
  });

  it('keeps at most the cap, dropping the oldest first', () => {
    for (let i = 0; i <= HIDDEN_UNOPENABLE_CAP; i++) hideUnopenable('user-c', `g-${i}`);
    expect(isHiddenFromList('g-0', 'pending')).toBe(false);
    expect(isHiddenFromList('g-1', 'pending')).toBe(true);
    expect(isHiddenFromList(`g-${HIDDEN_UNOPENABLE_CAP}`, 'pending')).toBe(true);
    const stored = JSON.parse(localStorage.getItem('canari_unopenable_hidden:v1:user-c') ?? '[]');
    expect(stored).toHaveLength(HIDDEN_UNOPENABLE_CAP);
  });
});
