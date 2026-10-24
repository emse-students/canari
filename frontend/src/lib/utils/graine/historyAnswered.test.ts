// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNT_KEY, accountLocalStorageKeysIn } from '../accountLocalKeys';
import {
  forgetHistoryHeldNothing,
  historyHeldNothingDevices,
  historyHeldNothingFinalAt,
  markHistoryHeldNothingFinal,
  recordHistoryHeldNothing,
} from './historyAnswered';

/** The durable "I hold nothing" record (channel-encryption section 24), keyed per answering device. */
describe('historyAnswered', () => {
  const at = { groupId: 'g-1', epoch: 7 };

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('keeps each answering DEVICE of one tree version, its user lower-cased', () => {
    expect(recordHistoryHeldNothing('alice', 'ws-1', at, 'Bob', 'web')).toBe(true);
    expect(recordHistoryHeldNothing('alice', 'ws-1', at, 'bob', 'laptop')).toBe(true);
    expect(recordHistoryHeldNothing('alice', 'ws-1', at, 'carol', 'web')).toBe(true);

    expect([...historyHeldNothingDevices('alice', 'ws-1', at)].sort()).toEqual([
      'bob:laptop',
      'bob:web',
      'carol:web',
    ]);
  });

  it('says a repeated answer from the same device is not new - the walk must not move on it', () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'bob', 'web');

    expect(recordHistoryHeldNothing('alice', 'ws-1', at, 'BOB', 'web')).toBe(false);
    expect(historyHeldNothingDevices('alice', 'ws-1', at).size).toBe(1);
  });

  it('reads nothing at another version, and an answer at a new version replaces the old ones', () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'bob', 'web');
    expect(historyHeldNothingDevices('alice', 'ws-1', { groupId: 'g-1', epoch: 8 }).size).toBe(0);
    expect(historyHeldNothingDevices('alice', 'ws-1', { groupId: 'g-2', epoch: 7 }).size).toBe(0);

    recordHistoryHeldNothing('alice', 'ws-1', { groupId: 'g-1', epoch: 8 }, 'carol', 'web');
    expect([...historyHeldNothingDevices('alice', 'ws-1', { groupId: 'g-1', epoch: 8 })]).toEqual([
      'carol:web',
    ]);
    expect(historyHeldNothingDevices('alice', 'ws-1', at).size).toBe(0);
  });

  it('is final only when marked, and only at the version marked', () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'bob', 'web');
    expect(historyHeldNothingFinalAt('alice', 'ws-1', at)).toBe(false);

    markHistoryHeldNothingFinal('alice', 'ws-1', { groupId: 'g-1', epoch: 6 });
    expect(historyHeldNothingFinalAt('alice', 'ws-1', at)).toBe(false);

    markHistoryHeldNothingFinal('alice', 'ws-1', at);
    expect(historyHeldNothingFinalAt('alice', 'ws-1', at)).toBe(true);
    expect(historyHeldNothingFinalAt('alice', 'ws-1', { groupId: 'g-1', epoch: 8 })).toBe(false);
  });

  it('reads a malformed record as none - which asks, never withholds a past', () => {
    localStorage.setItem(
      ACCOUNT_KEY.historyHeldNothing('alice'),
      JSON.stringify({
        'ws-1': { groupId: 'g-1', epoch: 7 },
        'ws-2': { ...at, devices: ['bob:web'] },
      })
    );

    expect(historyHeldNothingDevices('alice', 'ws-1', at).size).toBe(0);
    expect([...historyHeldNothingDevices('alice', 'ws-2', at)]).toEqual(['bob:web']);
  });

  it("forgets one community, and the account wipe names the account's key and no other", () => {
    recordHistoryHeldNothing('alice', 'ws-1', at, 'bob', 'web');
    recordHistoryHeldNothing('alice', 'ws-2', at, 'bob', 'web');
    recordHistoryHeldNothing('dave', 'ws-1', at, 'bob', 'web');

    forgetHistoryHeldNothing('alice', 'ws-1');
    expect(historyHeldNothingDevices('alice', 'ws-1', at).size).toBe(0);
    expect(historyHeldNothingDevices('alice', 'ws-2', at).size).toBe(1);

    // The one key holds every community of the account, OTHER members' ids included - all of it
    // written by this account's device, so the deletion's allowlist takes it whole.
    const swept = accountLocalStorageKeysIn(localStorage, 'alice');
    expect(swept).toContain(ACCOUNT_KEY.historyHeldNothing('alice'));
    // Another account on the same install keeps its own.
    expect(swept).not.toContain(ACCOUNT_KEY.historyHeldNothing('dave'));
  });
});
