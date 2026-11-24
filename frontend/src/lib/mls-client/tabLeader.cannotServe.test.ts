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
import {
  deliverBroadcasts,
  FakeBroadcastChannel,
  fakeLockManager,
  openDocument,
  settle,
} from './tabLeaderDocuments.test-helper';
import type { Doc } from './tabLeaderDocuments.test-helper';

describe('tabLeader - a tab whose session cannot serve gives the lead up', () => {
  let manager: ReturnType<typeof fakeLockManager>;
  const origLocks = navigator.locks;

  beforeEach(() => {
    manager = fakeLockManager();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: manager.locks });
    FakeBroadcastChannel.reset();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: origLocks });
    vi.unstubAllGlobals();
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
    await deliverBroadcasts();

    expect(
      asks.filter((a) => (a as { type?: string })?.type === 'leader_handover_request')
    ).toEqual([]);
    expect(leader.mod.getTabLeadership()).toBe('leader');
    ear.close();
  });

  /** A leaves the lead, B is promoted and reloads for it: the lock is free for that reload only. */
  async function promotionReloadInFlight() {
    const a = await openDocument();
    const b = await openDocument();
    a.mod.setTabLeadEligibility(false, 'session unavailable');
    await deliverBroadcasts();
    expect(b.mod.getTabLeadership()).toBe('leader');
    // What `useChatSession.reloadForPromotion` does, then the reload unloads B. Its hold listens on
    // the window from its promotion on (after `openDocument` stopped recording); only B holds a lock.
    b.mod.markPromotionReload();
    window.dispatchEvent(new Event('beforeunload'));
    await deliverBroadcasts();
    expect(manager.isHeld()).toBe(false);
    return { a, b };
  }

  it("a quick PIN retry during another tab's promotion reload does not take the lock in the gap (review of #4053)", async () => {
    const { a } = await promotionReloadInFlight();

    a.mod.setTabLeadEligibility(true, 'session starting');
    expect(await a.mod.initTabLeadershipAsync(() => {})).toBe(false);
    await deliverBroadcasts();
    // THE RACE: taken here, the lock was stolen from under A's login by B's reclaim a moment later.
    expect(manager.isHeld()).toBe(false);
    expect(a.mod.getTabLeadership()).toBe('follower');
    expect(a.logs.some((l) => l.includes('another tab is reloading after its promotion'))).toBe(
      true
    );

    // B's new page reclaims and says so; A queues behind it.
    const reloaded = await openDocument();
    await deliverBroadcasts();
    expect(reloaded.mod.getTabLeadership()).toBe('leader');
    expect(manager.queued()).toBe(1);
    expect(
      a.logs.some((l) => l.includes('Deferred rejoin ends (a tab announced it holds the lead)'))
    ).toBe(true);
    expect(a.mod.getTabLeadership()).toBe('follower');
  });

  it("a deferred rejoin ends when this tab's own session goes live, if the reloading tab never says it leads", async () => {
    const { a } = await promotionReloadInFlight();
    a.mod.setTabLeadEligibility(true, 'session starting');
    await a.mod.initTabLeadershipAsync(() => {});
    // The reloading tab was closed instead: nobody will announce the lead.
    sessionStorage.removeItem('canari_tab_promotion_reload');

    a.mod.noteTabSessionLive();
    await deliverBroadcasts();

    expect(a.mod.getTabLeadership()).toBe('leader');
    expect(a.promoted).toBe(1);
  });

  /** X leads, A then B queue; X's session ends, so A is promoted and reloads for it. */
  async function promotedReloadAheadOfAQueuedTab() {
    const x = await openDocument();
    const a = await openDocument();
    const b = await openDocument();
    expect(manager.queued()).toBe(2);
    x.mod.setTabLeadEligibility(false, 'session unavailable');
    await deliverBroadcasts();
    expect(a.mod.getTabLeadership()).toBe('leader');
    // A's own announcement, posted as it was promoted, has reached the others too.
    await deliverBroadcasts();
    expect(manager.queued()).toBe(1);
    return { a, b };
  }

  /** What `useChatSession.reloadForPromotion` does, then the reload unloads the promoted tab. */
  function reloadForPromotion(promoted: Doc): void {
    promoted.mod.markPromotionReload();
    unload(promoted);
  }

  /** The page goes: its own lifecycle listeners, and the hold it registered on the window since. */
  function unload(page: Doc): void {
    page.fire('beforeunload');
    window.dispatchEvent(new Event('beforeunload'));
  }

  // THIRD REVIEW OF #4053: a durable mark of the reload, honoured by a live tab, outlived a tab
  // closed during its reload and left every tab without a leader. Nothing marks it any more.
  it('a tab closed during its promotion reload leaves nothing behind: a later visible tab still leads', async () => {
    const { a, b } = await promotedReloadAheadOfAQueuedTab();
    // A reloads for its promotion and is closed in the middle of it: no page reclaims.
    reloadForPromotion(a);
    sessionStorage.clear();
    await deliverBroadcasts();
    // B, queued and live, took the lock the reload left free.
    expect(b.mod.getTabLeadership()).toBe('leader');

    // Later: B closes while F, the tab the member is in, waits in the queue - F leads.
    const f = await openDocument();
    expect(manager.queued()).toBe(1);
    unload(b);
    await deliverBroadcasts();
    expect(f.mod.getTabLeadership()).toBe('leader');
    expect(f.promoted).toBe(1);
  });

  it('a live tab granted the lock in a promotion reload gap leads, and the reclaim demotes it once', async () => {
    const { a, b } = await promotedReloadAheadOfAQueuedTab();
    reloadForPromotion(a);
    await deliverBroadcasts();
    expect(b.mod.getTabLeadership()).toBe('leader');

    // A's new page reclaims with a steal: B hands over, and that demotion is its one extra reload.
    const reloaded = await openDocument();
    await deliverBroadcasts();
    expect(reloaded.mod.getTabLeadership()).toBe('leader');
    expect(b.mod.getTabLeadership()).toBe('follower');
    expect(b.demotions).toEqual(['lead-moved']);
  });
});
