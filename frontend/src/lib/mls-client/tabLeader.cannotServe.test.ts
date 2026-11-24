// @vitest-environment happy-dom
/**
 * THE LEAD BELONGS TO A TAB THAT CAN SERVE IT (owner's screenshot, web, 2026-11-24).
 *
 * A follower tab's "Nouvelle discussion" was answered "L'onglet principal de Canari n'est pas pret
 * (verrouille ou deconnecte)": the leader tab's session had ended in place (the PIN keypad back up, a
 * sign-out, an expired session sent to `/login` without an unload), and it kept the Web Lock until
 * its document unloaded. No tab could take the lead from it, so every gesture the follower handed
 * over was refused, for as long as that tab stayed open.
 *
 * Two documents of one browser, sharing one lock manager (`tabLeaderDocuments.test-helper.ts`).
 * Eligibility is what the session's flags say (`useChatSession.publishDelegationReadiness`).
 */
import { fakeLockManager, openDocument, settle } from './tabLeaderDocuments.test-helper';

describe('tabLeader - a tab whose session cannot serve gives the lead up', () => {
  let manager: ReturnType<typeof fakeLockManager>;
  const origLocks = navigator.locks;

  beforeEach(() => {
    manager = fakeLockManager();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: manager.locks });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: origLocks });
    vi.restoreAllMocks();
  });

  it('a leader whose session ends releases the lock, and the tab that can serve is promoted', async () => {
    const locked = await openDocument();
    const ready = await openDocument();
    expect(locked.mod.getTabLeadership()).toBe('leader');
    expect(ready.mod.getTabLeadership()).toBe('follower');

    locked.mod.setTabLeadEligibility(false, 'session unavailable');
    await settle();

    // THE DEFECT: the locked tab kept the lock until it unloaded, and the ready one stayed a
    // follower whose every handed-over gesture was answered `leader-unavailable`.
    expect(ready.mod.getTabLeadership()).toBe('leader');
    expect(ready.promoted).toBe(1);
    // Follower FIRST: nothing the locked document still runs believes it leads.
    expect(locked.mod.getTabLeadership()).toBe('follower');
    expect(locked.auth.refusesCommitsHere()).toBe(true);
    // Told why, so the session does not reload a page showing the keypad.
    expect(locked.demotions).toEqual(['session-cannot-serve']);
    // It holds nothing and waits for nothing: it is not in the queue either.
    expect(manager.queued()).toBe(0);
    expect(
      locked.logs.some((l) =>
        l.includes('cannot serve (session unavailable) while leading - the lock is released')
      )
    ).toBe(true);
  });

  it('it rejoins the election at its next login - as a follower behind the tab that took the lead', async () => {
    const first = await openDocument();
    const second = await openDocument();
    first.mod.setTabLeadEligibility(false, 'session unavailable');
    await settle();

    first.mod.setTabLeadEligibility(true, 'session starting');
    // The login awaits the election as its own: the rejoin, not the first election's memo.
    const leads = await first.mod.initTabLeadershipAsync((m) => first.logs.push(m));
    await settle();

    expect(leads).toBe(false);
    expect(first.mod.getTabLeadership()).toBe('follower');
    expect(second.mod.getTabLeadership()).toBe('leader');
    expect(manager.queued()).toBe(1);
    expect(
      first.logs.some((l) => l.includes('can serve again (session starting) - it rejoins'))
    ).toBe(true);

    // And it is promoted when the leader's own session ends in turn.
    second.mod.setTabLeadEligibility(false, 'session unavailable');
    await settle();
    expect(first.mod.getTabLeadership()).toBe('leader');
    expect(first.promoted).toBe(1);
    expect(second.mod.getTabLeadership()).toBe('follower');
  });

  it('a follower whose session ends withdraws its request: the lead never goes to a locked tab', async () => {
    const leader = await openDocument();
    const locked = await openDocument();
    expect(manager.queued()).toBe(1);

    locked.mod.setTabLeadEligibility(false, 'session unavailable');
    await settle();
    expect(manager.queued()).toBe(0);

    // The leader closes: before, the locked follower was granted the lead and kept it while it
    // could serve nothing - the same dead end, reached from the other side.
    leader.fire('beforeunload');
    await settle();
    expect(locked.mod.getTabLeadership()).toBe('follower');
    expect(locked.promoted).toBe(0);
    expect(manager.isHeld()).toBe(false);

    // Its next login takes the free lock at once, in its own election.
    locked.mod.setTabLeadEligibility(true, 'session starting');
    expect(await locked.mod.initTabLeadershipAsync(() => {})).toBe(true);
    expect(locked.mod.getTabLeadership()).toBe('leader');
  });

  it('a lone tab whose session ends leaves the lock free, and takes it back at its next login', async () => {
    const alone = await openDocument();
    alone.mod.setTabLeadEligibility(false, 'session unavailable');
    await settle();
    expect(manager.isHeld()).toBe(false);
    expect(alone.mod.getTabLeadership()).toBe('follower');

    alone.mod.setTabLeadEligibility(true, 'session starting');
    expect(await alone.mod.initTabLeadershipAsync(() => {})).toBe(true);
    await settle();
    expect(manager.isHeld()).toBe(true);
    // Never its own rival: one hold, nothing queued behind it (the 2026-09-21 defect).
    expect(manager.queued()).toBe(0);
  });

  it('repeating the same eligibility is a no-op: one release, one line', async () => {
    const doc = await openDocument();
    doc.mod.setTabLeadEligibility(true, 'session ready');
    await settle();
    expect(doc.mod.getTabLeadership()).toBe('leader');
    expect(doc.demotions).toEqual([]);

    doc.mod.setTabLeadEligibility(false, 'session unavailable');
    doc.mod.setTabLeadEligibility(false, 'session unavailable');
    await settle();
    expect(doc.demotions).toEqual(['session-cannot-serve']);
    expect(
      doc.logs.filter((l) => l.includes('cannot serve (session unavailable) while leading'))
    ).toHaveLength(1);
  });

  it('a visible follower whose session cannot serve asks no hidden leader for the lead', async () => {
    const leader = await openDocument();
    const follower = await openDocument();
    const asks: unknown[] = [];
    const ear = new BroadcastChannel('canari-mls-tab');
    ear.addEventListener('message', (ev) => asks.push((ev as MessageEvent).data));
    follower.mod.setTabLeadEligibility(false, 'session unavailable');

    follower.mod.requestLeaderHandover(() => {});
    await settle();

    expect(
      asks.filter((a) => (a as { type?: string })?.type === 'leader_handover_request')
    ).toEqual([]);
    expect(leader.mod.getTabLeadership()).toBe('leader');
    ear.close();
  });
});
