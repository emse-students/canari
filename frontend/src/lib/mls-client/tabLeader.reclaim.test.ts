// @vitest-environment happy-dom
/**
 * NO LOADED LEADER IS EVER STOLEN FROM (fourth review of #4053, M1).
 *
 * The page a promotion reload starts used to reclaim the lock with a STEAL. Two tabs promoted in place
 * reload one after the other, so the second page's steal took the lock from the first - already loaded
 * as the leader, possibly in the middle of an external join or a group's first publish, whose
 * checkpoint the latch then refused: a fork or a ghost leaf. The reload's page now waits in the queue
 * while no tab serves the lead (`canari-tab-serving`), and follows the tab that does.
 *
 * Two or more documents of one browser, one lock manager (`tabLeaderDocuments.test-helper.ts`).
 */
import {
  deliverBroadcasts,
  FakeBroadcastChannel,
  fakeLockManager,
  openDocument,
  type Doc,
} from './tabLeaderDocuments.test-helper';

describe('tabLeader - a promotion reload waits for the lead, and never steals it', () => {
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

  /** The page goes: its own lifecycle listeners, and the hold it registered on the window since. */
  function unload(page: Doc): void {
    page.fire('beforeunload');
    window.dispatchEvent(new Event('beforeunload'));
  }

  /** What `useChatSession.reloadForPromotion` does, then the reload unloads the promoted tab. */
  function reloadForPromotion(promoted: Doc): void {
    promoted.mod.markPromotionReload();
    unload(promoted);
  }

  /** X leads and serves; A then B queue behind it, loaded as followers. X closes: A is promoted. */
  async function aPromotedInPlaceAheadOfB() {
    const x = await openDocument();
    const a = await openDocument();
    const b = await openDocument();
    expect(manager.serving()).toBe(true);
    unload(x);
    await deliverBroadcasts();
    expect(a.mod.getTabLeadership()).toBe('leader');
    expect(a.promoted).toBe(1);
    // Promoted in place, on a copy loaded as a follower: it leads, and serves nothing.
    expect(manager.serving()).toBe(false);
    return { a, b };
  }

  it('two tabs promoted in place reload in turn: the first page granted leads, the second follows it - nothing stolen', async () => {
    const { a, b } = await aPromotedInPlaceAheadOfB();
    reloadForPromotion(a);
    await deliverBroadcasts();
    // The reload left the lock to B, promoted in place in turn.
    expect(b.mod.getTabLeadership()).toBe('leader');

    // A's next page: no tab serves, so it waits in the queue - it does not steal from B.
    const a2 = await openDocument({ pending: true });
    await deliverBroadcasts();
    expect(a2.mod.getTabLeadership()).toBe('undecided');
    expect(b.mod.getTabLeadership()).toBe('leader');

    // B reloads for its own promotion: the lock goes to A's waiting page, whose login loads as leader.
    reloadForPromotion(b);
    await deliverBroadcasts();
    expect(await a2.elected).toBe(true);
    expect(a2.auth.servesFollowerCommits()).toBe(true);
    expect(manager.serving()).toBe(true);

    // B's next page finds a tab serving: it follows at once, and A2 - loaded as leader - keeps it.
    const b2 = await openDocument();
    await deliverBroadcasts();
    expect(b2.mod.getTabLeadership()).toBe('follower');
    expect(b2.logs.some((l) => l.includes('another tab serves the lead - this page follows'))).toBe(
      true
    );
    expect(a2.mod.getTabLeadership()).toBe('leader');
    expect(a2.demoted).toBe(0);
    expect(manager.queued()).toBe(1);
  });

  it('a page waiting for the lead stops waiting when another waiting page is granted it and serves', async () => {
    const { a, b } = await aPromotedInPlaceAheadOfB();
    reloadForPromotion(a);
    await deliverBroadcasts();
    expect(b.mod.getTabLeadership()).toBe('leader');
    const a2 = await openDocument({ pending: true });
    // Another tab's page, reloaded after a promotion of its own, waits behind A2.
    sessionStorage.setItem('canari_tab_promotion_reload', '1');
    const c2 = await openDocument({ pending: true });
    await deliverBroadcasts();
    expect(manager.queued()).toBe(2);

    reloadForPromotion(b);
    await deliverBroadcasts();

    expect(await a2.elected).toBe(true);
    // C2 heard A2 serve: it follows, and keeps its place in the queue as an ordinary request.
    expect(await c2.elected).toBe(false);
    expect(c2.mod.getTabLeadership()).toBe('follower');
    expect(
      c2.logs.some((l) => l.includes('Stops waiting for the lead (another tab serves the lead)'))
    ).toBe(true);
    expect(manager.queued()).toBe(1);
    expect(a2.demoted).toBe(0);
  });

  it('a reloaded page whose query answers after another tab was heard serving follows that tab', async () => {
    // The browser answers the query on a later task: a `leader_serving` can land before it does.
    const x = await openDocument();
    const a = await openDocument();
    unload(x);
    await deliverBroadcasts();
    expect(a.mod.getTabLeadership()).toBe('leader');
    reloadForPromotion(a);
    await deliverBroadcasts();

    manager.holdQueries();
    const a2 = await openDocument({ pending: true });
    await deliverBroadcasts();
    // A2's question was asked while nothing served, and is not answered yet.
    expect(sessionStorage.getItem('canari_tab_promotion_reload')).toBeNull();
    expect(a2.mod.getTabLeadership()).toBe('undecided');

    // A fresh page takes the free lock and serves; A2 hears it before its answer arrives.
    const f = await openDocument();
    expect(f.mod.getTabLeadership()).toBe('leader');
    await deliverBroadcasts();
    manager.releaseQueries();
    await deliverBroadcasts();

    // THE DEFECT: the answer said "nobody serves" and A2 queued behind F, its login waiting forever.
    expect(await a2.elected).toBe(false);
    expect(a2.mod.getTabLeadership()).toBe('follower');
    expect(a2.logs.some((l) => l.includes('another tab serves the lead - this page follows'))).toBe(
      true
    );
    expect(f.mod.getTabLeadership()).toBe('leader');
    expect(f.demoted).toBe(0);
  });

  it('the serving tab dies: a waiting page is granted the lead, serves, and ends the other waits', async () => {
    const x = await openDocument();
    const a = await openDocument();
    const b = await openDocument();
    expect(manager.serving()).toBe(true);
    // A crash: no beforeunload, no code run - the browser releases what X held and queued.
    manager.kill(x);
    await deliverBroadcasts();
    expect(manager.serving()).toBe(false);
    expect(a.mod.getTabLeadership()).toBe('leader');
    reloadForPromotion(a);
    await deliverBroadcasts();
    expect(b.mod.getTabLeadership()).toBe('leader');

    // Two reloaded pages wait in the queue for a lead nobody serves.
    const a2 = await openDocument({ pending: true });
    sessionStorage.setItem('canari_tab_promotion_reload', '1');
    const c2 = await openDocument({ pending: true });
    await deliverBroadcasts();
    expect(manager.queued()).toBe(2);

    // B dies in turn, promoted in place and never reloaded: the first waiting page is granted.
    manager.kill(b);
    await deliverBroadcasts();

    expect(await a2.elected).toBe(true);
    expect(a2.auth.servesFollowerCommits()).toBe(true);
    expect(manager.serving()).toBe(true);
    expect(await c2.elected).toBe(false);
    expect(c2.mod.getTabLeadership()).toBe('follower');
    expect(
      c2.logs.some((l) => l.includes('Stops waiting for the lead (another tab serves the lead)'))
    ).toBe(true);
    expect(manager.queued()).toBe(1);
  });

  it('a lone page reloaded after its promotion takes the free lock and serves', async () => {
    const a = await openDocument();
    const b = await openDocument();
    unload(a);
    await deliverBroadcasts();
    expect(b.mod.getTabLeadership()).toBe('leader');
    reloadForPromotion(b);
    await deliverBroadcasts();

    const b2 = await openDocument();
    expect(b2.mod.getTabLeadership()).toBe('leader');
    expect(manager.serving()).toBe(true);
  });
});

describe('tabLeader - a hidden leader hands the lead over only once its MLS work settled', () => {
  let manager: ReturnType<typeof fakeLockManager>;
  const origLocks = navigator.locks;
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    manager = fakeLockManager();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: manager.locks });
    FakeBroadcastChannel.reset();
    sessionStorage.clear();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: origLocks });
    delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('an ask that lands while a lead hold is held is answered when the hold settles - never before', async () => {
    const hidden = await openDocument();
    const asker = await openDocument();
    // An external join's commit is on the wire: the checkpoint it owes needs the lead.
    const release = hidden.holds.takeLeadHold('external join g-1');

    visibility = 'visible';
    asker.mod.requestLeaderHandover((m) => asker.logs.push(m));
    visibility = 'hidden';
    await deliverBroadcasts();
    await deliverBroadcasts();

    // THE DEFECT: the leader decided `follower` here and its checkpoint was refused.
    expect(hidden.mod.getTabLeadership()).toBe('leader');
    expect(asker.mod.getTabLeadership()).toBe('follower');
    expect(hidden.logs.some((l) => l.includes('while MLS work needs it'))).toBe(true);

    release();
    await deliverBroadcasts();
    await deliverBroadcasts();

    expect(hidden.mod.getTabLeadership()).toBe('follower');
    expect(asker.mod.getTabLeadership()).toBe('leader');
    expect(asker.promoted).toBe(1);
    expect(manager.queued()).toBe(0);
  });
});
