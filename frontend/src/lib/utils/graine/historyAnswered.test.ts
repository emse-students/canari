import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearHistoryHeldNothing,
  forgetHistoryHeldNothing,
  historyHeldNothingBy,
  historyHeldNothingFinalAt,
  historyHeldNothingStorageKey,
  markHistoryHeldNothingFinal,
  recordHistoryHeldNothing,
} from './historyAnswered';

/** The durable "I hold nothing" record (channel-encryption section 24), keyed per answerer. */
describe('historyAnswered', () => {
  const at = { groupId: 'g-1', epoch: 7 };

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('keeps each answerer of one roster version, lower-cased', () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'Bob');
    recordHistoryHeldNothing('alice', 'ws-1', at, 'carol');

    expect([...historyHeldNothingBy('alice', 'ws-1', at)].sort()).toEqual(['bob', 'carol']);
  });

  it('reads nothing at another version, and an answer at a new version replaces the old ones', () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'bob');
    expect(historyHeldNothingBy('alice', 'ws-1', { groupId: 'g-1', epoch: 8 }).size).toBe(0);
    expect(historyHeldNothingBy('alice', 'ws-1', { groupId: 'g-2', epoch: 7 }).size).toBe(0);

    recordHistoryHeldNothing('alice', 'ws-1', { groupId: 'g-1', epoch: 8 }, 'carol');
    expect([...historyHeldNothingBy('alice', 'ws-1', { groupId: 'g-1', epoch: 8 })]).toEqual([
      'carol',
    ]);
    expect(historyHeldNothingBy('alice', 'ws-1', at).size).toBe(0);
  });

  it('is final only when marked, and only at the version marked', () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'bob');
    expect(historyHeldNothingFinalAt('alice', 'ws-1', at)).toBe(false);

    markHistoryHeldNothingFinal('alice', 'ws-1', { groupId: 'g-1', epoch: 6 });
    expect(historyHeldNothingFinalAt('alice', 'ws-1', at)).toBe(false);

    markHistoryHeldNothingFinal('alice', 'ws-1', at);
    expect(historyHeldNothingFinalAt('alice', 'ws-1', at)).toBe(true);
    expect(historyHeldNothingFinalAt('alice', 'ws-1', { groupId: 'g-1', epoch: 8 })).toBe(false);
  });

  it('reads a malformed record as none - which asks, never withholds a past', () => {
    localStorage.setItem(
      historyHeldNothingStorageKey('alice'),
      JSON.stringify({
        'ws-1': { groupId: 'g-1', epoch: 7 },
        'ws-2': { ...at, answerers: ['bob'] },
      })
    );

    expect(historyHeldNothingBy('alice', 'ws-1', at).size).toBe(0);
    expect([...historyHeldNothingBy('alice', 'ws-2', at)]).toEqual(['bob']);
  });

  it('forgets one community, and the account wipe removes the whole key', () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'bob');
    recordHistoryHeldNothing('alice', 'ws-2', at, 'bob');
    recordHistoryHeldNothing('dave', 'ws-1', at, 'bob');

    forgetHistoryHeldNothing('alice', 'ws-1');
    expect(historyHeldNothingBy('alice', 'ws-1', at).size).toBe(0);
    expect(historyHeldNothingBy('alice', 'ws-2', at).size).toBe(1);

    clearHistoryHeldNothing('alice');
    expect(localStorage.getItem(historyHeldNothingStorageKey('alice'))).toBeNull();
    // Another account on the same install keeps its own.
    expect(historyHeldNothingBy('dave', 'ws-1', at).size).toBe(1);
  });
});
