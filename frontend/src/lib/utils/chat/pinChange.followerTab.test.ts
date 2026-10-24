// @vitest-environment happy-dom
/**
 * A PIN change asked from a FOLLOWER tab, across two realms of one account.
 *
 * Each realm is a fresh import (`vi.resetModules`) of the tab election, the PIN change and the MLS
 * state store, sharing one Web Locks manager, one broadcast bus and one IndexedDB - what two tabs of
 * an origin share. The follower's live MLS client is older than the leader's last checkpoint, so the
 * version guard refuses its re-seal: the change used to rotate the server verifier, then end into a
 * recovery prompt (`MlsStateWriteRefusedError`). It is now refused in the follower, before anything.
 */
import 'fake-indexeddb/auto';
import { FakeChannel, FakeLocks } from '../../../test/crossRealmDoubles';
// Loaded once here so each realm's fresh import re-evaluates already-transformed code: the first
// cold transform of the PIN change's import graph is seconds, and a test's own timeout is not the
// place to pay it.
import './pinChange';

interface Realm {
  tabs: typeof import('$lib/mls-client/tabLeader');
  pinChange: typeof import('./pinChange');
  state: typeof import('$lib/utils/hex');
}

async function realm(): Promise<Realm> {
  vi.resetModules();
  return {
    tabs: await import('$lib/mls-client/tabLeader'),
    pinChange: await import('./pinChange'),
    state: await import('$lib/utils/hex'),
  };
}

let counter = 0;

beforeEach(() => {
  FakeChannel.open = [];
  Object.defineProperty(navigator, 'locks', { value: new FakeLocks(), configurable: true });
  vi.stubGlobal('BroadcastChannel', FakeChannel);
});

afterEach(() => {
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  vi.unstubAllGlobals();
});

describe('a PIN change from a follower tab', () => {
  it('is refused in the follower, before anything is asked, and allowed in the leader', async () => {
    const leader = await realm();
    const follower = await realm();
    const log = vi.fn();

    expect(await leader.tabs.initTabLeadershipAsync(() => {})).toBe(true);
    expect(await follower.tabs.initTabLeadershipAsync(() => {})).toBe(false);

    expect(follower.pinChange.thisTabMayChangeDeviceKey(log)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Refused in this tab (follower)'));
    expect(leader.pinChange.thisTabMayChangeDeviceKey(() => {})).toBe(true);
  });

  it('is refused while leadership is not decided: a key change is never started on a guess', async () => {
    const undecided = await realm();
    expect(undecided.tabs.getTabLeadership()).toBe('undecided');
    expect(undecided.pinChange.thisTabMayChangeDeviceKey(() => {})).toBe(false);
  });

  it("WHY: the follower's live re-seal is refused by the version guard once the leader checkpointed", async () => {
    // The fact the refusal stands on. If this ever passes with `written`, a follower could re-seal
    // its own client and the refusal could be lifted.
    const userId = `follower-tab-${counter++}`;
    const leader = await realm();
    const follower = await realm();
    await leader.state.saveMlsState(userId, new Uint8Array([1])); // untagged: the stored state
    // Both tabs boot from that state (the read seeds each realm's snapshot counter)...
    await leader.state.loadMlsState(userId);
    await follower.state.loadMlsState(userId);
    // ...and only the leader runs MLS, so only the leader checkpoints after.
    for (const b of [2, 3]) {
      const capture = leader.state.tagMlsSnapshot(new Uint8Array([b]), 'checkpoint');
      expect(await leader.state.saveMlsState(userId, capture)).toBe('written');
    }

    const reSeal = follower.state.tagMlsSnapshot(new Uint8Array([9]), 'device-key-change');
    expect(await follower.state.saveMlsState(userId, reSeal)).not.toBe('written');
    expect(await leader.state.loadMlsState(userId)).toEqual(new Uint8Array([3]));
  });
});
