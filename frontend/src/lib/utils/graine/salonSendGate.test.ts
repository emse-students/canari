import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginSalonEntry,
  beginSalonListing,
  settleSalonEntry,
  forgetSalonSendGates,
  openSalonSendGate,
  readSalonSendGate,
  resetSalonSendGate,
  salonSendWaiterCount,
  settleSalonListing,
  whenSalonSendable,
} from './salonSendGate';

/**
 * The gate a salon send waits on (`salonSendGate.ts`). Every way out of a wait is an EVENT, and
 * each test below is one of them; none involves a clock.
 */
describe('salonSendGate', () => {
  beforeEach(() => resetSalonSendGate());

  it('waits before any listing has settled in this session', () => {
    expect(readSalonSendGate('channel_a')).toEqual({ kind: 'wait' });
  });

  it('answers ready for an entered salon, with or without the conversation prefix', async () => {
    openSalonSendGate('a');
    expect(readSalonSendGate('channel_a')).toEqual({ kind: 'ready' });
    expect(await whenSalonSendable('a')).toEqual({ kind: 'ready' });
  });

  it('releases a waiter when its salon is entered, and only that one', async () => {
    beginSalonListing();
    const a = whenSalonSendable('channel_a');
    void whenSalonSendable('channel_b');
    openSalonSendGate('a');
    expect(await a).toEqual({ kind: 'ready' });
    expect(salonSendWaiterCount('b')).toBe(1);
  });

  it('refuses the waiters a settled listing did not enter, naming how it ended', async () => {
    const t1 = beginSalonListing();
    const a = whenSalonSendable('a');
    settleSalonListing(t1, 'loaded');
    expect(await a).toEqual({ kind: 'refused', reason: 'not-listed' });

    const t2 = beginSalonListing();
    const b = whenSalonSendable('b');
    settleSalonListing(t2, 'failed');
    expect(await b).toEqual({ kind: 'refused', reason: 'listing-failed' });
    // And a send made after that answers at once, without waiting.
    expect(readSalonSendGate('c')).toEqual({ kind: 'refused', reason: 'listing-failed' });
  });

  it('keeps waiting while ANOTHER listing is still in flight (the reload owed to a join)', async () => {
    const first = beginSalonListing();
    const a = whenSalonSendable('a');
    beginSalonListing(); // the owed reload, begun before the first one settles
    settleSalonListing(first, 'loaded');
    expect(salonSendWaiterCount('a')).toBe(1);
    openSalonSendGate('a');
    expect(await a).toEqual({ kind: 'ready' });
  });

  it('refuses the waiters of a forgotten community as left, and closes their gate', async () => {
    openSalonSendGate('open-one');
    beginSalonListing();
    const a = whenSalonSendable('a');
    forgetSalonSendGates(['channel_a', 'open-one']);
    expect(await a).toEqual({ kind: 'refused', reason: 'left' });
    expect(readSalonSendGate('open-one')).toEqual({ kind: 'wait' });
  });

  it('refuses every waiter on sign-out and starts the next session from scratch', async () => {
    openSalonSendGate('a');
    beginSalonListing();
    const b = whenSalonSendable('b');
    resetSalonSendGate();
    expect(await b).toEqual({ kind: 'refused', reason: 'session-ended' });
    expect(readSalonSendGate('a')).toEqual({ kind: 'wait' });
  });

  it('ignores a listing of the previous session settling into this one', () => {
    const stale = beginSalonListing();
    resetSalonSendGate();
    void whenSalonSendable('a');
    settleSalonListing(stale, 'loaded');
    // Still waiting for THIS session's own first listing, not refused by the last one's.
    expect(salonSendWaiterCount('a')).toBe(1);
    expect(readSalonSendGate('a')).toEqual({ kind: 'wait' });
  });

  it('holds a send for a salon being entered in-session, after the listing settled without it', async () => {
    settleSalonListing(beginSalonListing(), 'loaded');
    const entry = beginSalonEntry();
    const a = whenSalonSendable('a');
    expect(salonSendWaiterCount('a')).toBe(1);
    openSalonSendGate('a');
    settleSalonEntry(entry);
    expect(await a).toEqual({ kind: 'ready' });
  });

  it('refuses as the last listing did when an entry ends without opening its salon', async () => {
    settleSalonListing(beginSalonListing(), 'failed');
    const entry = beginSalonEntry();
    const a = whenSalonSendable('a');
    settleSalonEntry(entry);
    expect(await a).toEqual({ kind: 'refused', reason: 'listing-failed' });
  });

  it('keeps waiting for the first listing when an entry ends before any listing settled', () => {
    const entry = beginSalonEntry();
    void whenSalonSendable('a');
    settleSalonEntry(entry);
    expect(salonSendWaiterCount('a')).toBe(1);
  });

  it('releases a waiter once even if two events follow', async () => {
    const t = beginSalonListing();
    let calls = 0;
    const a = whenSalonSendable('a').then((outcome) => {
      calls += 1;
      return outcome;
    });
    openSalonSendGate('a');
    settleSalonListing(t, 'loaded');
    expect(await a).toEqual({ kind: 'ready' });
    expect(calls).toBe(1);
  });
});
