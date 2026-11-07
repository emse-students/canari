// @vitest-environment happy-dom
/**
 * THE WELCOME TOUR ON THE REAL OVERLAY, ON BOTH LAYOUTS: it starts when the route has settled and
 * the app is quiet, points at the control the layout draws, says "n/N", moves focus into its bubble,
 * announces each step, and ends - recorded as seen - by Next, "Passer", Esc and Back (Android's
 * included: its entry is published to the native Back like any overlay's). It does not start over a
 * covering surface, a tour on screen is SUSPENDED by a call or a modal and comes back after, and it
 * drops its infinite motion under `prefers-reduced-motion`.
 *
 * The anchors are registered through the real `guideAnchor` action on stand-in controls, with the
 * box a real layout would give them: happy-dom lays nothing out, so a control the breakpoint hides
 * is one with no client rect, which is exactly what `display: none` gives a browser.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Svelte itself, imported AFTER each `vi.resetModules` so the component and the test share one runtime. */
let sv: typeof import('svelte');
const flushSync = () => sv.flushSync();

type NavCallback = (nav: { to: { url: URL } | null; shallow?: boolean; type?: string }) => unknown;

const nav = vi.hoisted(() => ({ after: [] as NavCallback[], before: [] as NavCallback[] }));
const layout = vi.hoisted(() => ({ phone: true, swipe: true }));
const seen = vi.hoisted(() => ({ ids: new Set<string>() }));
const markSeen = vi.hoisted(() => vi.fn((id: string) => seen.ids.add(id)));
const modalWebLayer = vi.hoisted(() => ({ covering: false }));

vi.mock('$app/navigation', () => ({
  afterNavigate: (cb: NavCallback) => nav.after.push(cb),
  beforeNavigate: (cb: NavCallback) => nav.before.push(cb),
  goto: async () => {},
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/posts') } }));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1', isGlobalAdmin: () => false }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  isBelowMinClientVersion: () => false,
  isMaintenanceBlockingCurrentUser: () => false,
}));
vi.mock('$lib/stores/keyboardViewport.svelte', () => ({
  getKeyboardViewport: () => ({ isOpen: false }),
}));
vi.mock('$lib/navigation/nativeTabBarState.svelte', () => ({
  nativeTabBar: { status: 'pending' },
  modalWebLayer,
}));
vi.mock('$lib/utils/appVersion', () => ({ isIosTauriRuntime: () => false }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
vi.mock('$lib/utils/viewport', async (original) => ({
  ...(await original<typeof import('$lib/utils/viewport')>()),
  isPhoneViewport: () => layout.phone,
  isSwipeNavViewport: () => layout.swipe,
  onViewportChange: () => () => {},
}));
vi.mock('$lib/guidance/seenHelps.svelte', () => ({
  seenHelps: {
    ready: true,
    has: (id: string) => seen.ids.has(id),
    ageSeconds: () => null,
    markSeen,
    load: async () => {},
  },
  resetSeenHelps: () => {},
}));
// The account has a photo here, so the profile-photo prompt never competes with the tour under test.
vi.mock('$lib/guidance/ownProfilePhoto.svelte', () => ({
  ownProfilePhoto: { hasPhoto: true, load: async () => {} },
}));

let cleanup: (() => void)[] = [];

/** A stand-in control at `box`, or with no box at all when its layout hides it. */
function control(box: DOMRect | null): HTMLElement {
  const el = document.createElement('a');
  document.body.append(el);
  el.getClientRects = () => (box ? [box] : []) as unknown as DOMRectList;
  el.getBoundingClientRect = () => box ?? new DOMRect(0, 0, 0, 0);
  return el;
}

async function setUp(options: { reducedMotion?: boolean; covered?: boolean } = {}) {
  vi.resetModules();
  // A REACTIVE session, registered after the reset so it is built on the runtime the component gets
  // (a hoisted `vi.mock` keeps the first one it made - see the fixture).
  vi.doMock(
    '$lib/stores/globalChatSingleton.svelte',
    () => import('./guideOverlayTestSession.svelte')
  );
  sv = await import('svelte');
  nav.after.length = 0;
  nav.before.length = 0;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduced-motion') ? !!options.reducedMotion : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;

  const { guideAnchor } = await import('$lib/guidance/guideAnchors.svelte');
  const history = await import('$lib/utils/historyOverlayStack');
  cleanup.push(history.initHistoryOverlayStack());

  // Both navigations are mounted on every width, as in the app; the breakpoint decides which is drawn.
  const phoneBar = { posts: 0, communities: 1, chat: 2, dashboard: 3 };
  for (const [id, i] of Object.entries(phoneBar)) {
    const box = layout.phone ? new DOMRect(i * 97, 796, 97, 48) : null;
    cleanup.push(guideAnchor(control(box), `nav.${id}`).destroy);
  }
  const rail = ['posts', 'communities', 'chat', 'notifications', 'calendar'];
  rail.forEach((id, i) => {
    const box = layout.phone ? null : new DOMRect(12, 80 + i * 54, 48, 48);
    cleanup.push(guideAnchor(control(box), `nav.${id}`).destroy);
  });
  const avatarBox = layout.phone ? new DOMRect(340, 6, 44, 44) : new DOMRect(1380, 12, 40, 40);
  cleanup.push(guideAnchor(control(avatarBox), 'nav.profile').destroy);

  if (options.covered) {
    const { coversScreen } = await import('$lib/actions/coversScreen.svelte');
    cleanup.push(coversScreen(control(new DOMRect(0, 0, 390, 844))).destroy);
  }

  const { default: GuideOverlay } = await import('./GuideOverlay.svelte');
  const target = document.body.appendChild(document.createElement('div'));
  const instance = sv.mount(GuideOverlay, { target, props: { chromeless: false } });
  cleanup.push(() => sv.unmount(instance));
  flushSync();
  // The route settles: `afterNavigate` runs once the page has mounted.
  for (const cb of nav.after) await cb({ to: { url: new URL('http://localhost/posts') } });
  flushSync();
  await sv.tick();
  flushSync();
  return {
    history,
    engine: (await import('$lib/guidance/guidance.svelte')).guideEngine,
    // Through the MOCKED path: the module the component imported, not a second copy of the fixture.
    session: (await import('$lib/stores/globalChatSingleton.svelte')).globalSession as {
      isLoggedIn: boolean;
      callState: string;
    },
  };
}

const bubble = () => document.querySelector<HTMLElement>('[data-guide-bubble]');
const stepId = () =>
  document.querySelector('[data-guide-overlay]')?.getAttribute('data-guide-step');
const counter = () => document.querySelector('[data-guide-counter]')?.textContent?.trim();
const click = (selector: string) => {
  document.querySelector<HTMLElement>(selector)!.click();
  flushSync();
};
const key = (k: string) => {
  bubble()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  flushSync();
};

// The first import transforms the component's whole graph; every later `resetModules` reuses it.
beforeAll(async () => {
  vi.doMock(
    '$lib/stores/globalChatSingleton.svelte',
    () => import('./guideOverlayTestSession.svelte')
  );
  await import('./GuideOverlay.svelte');
}, 60_000);

beforeEach(() => {
  seen.ids.clear();
  markSeen.mockClear();
  layout.phone = true;
  layout.swipe = true;
});

afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).canariBack;
});

/** The spotlight's offset, read off its transform (it is placed by `translate`, never left/top). */
function spotOffset(): { x: string; y: string } {
  const spot = document.querySelector<HTMLElement>('[data-guide-spotlight]')!;
  const match = /translate\(([-\d.]+px), ([-\d.]+px)\)/.exec(spot.style.transform);
  return { x: match?.[1] ?? '', y: match?.[2] ?? '' };
}

describe('the welcome tour on a phone', () => {
  it('walks six steps on the bottom bar and the header, then records itself', async () => {
    await setUp();
    const visited: string[] = [];
    for (let i = 0; i < 6; i++) {
      visited.push(stepId()!);
      expect(counter()).toBe(`${i + 1}/6`);
      click('[data-guide-next]');
    }
    expect(visited).toEqual(['welcome', 'feed', 'chats', 'camera', 'agenda', 'profile']);
    expect(bubble()).toBeNull();
    expect(markSeen).toHaveBeenCalledExactlyOnceWith('welcome-tour');
  });

  it('lights the control the phone draws, and is modal', async () => {
    await setUp();
    click('[data-guide-next]');
    expect(stepId()).toBe('feed');
    // The bar's first tab (0, 796, 97x48), grown by the 0.375rem halo padding.
    expect(spotOffset()).toEqual({ x: '-6px', y: '790px' });
    expect(document.querySelector('[data-guide-blocker]')).not.toBeNull();
    expect(bubble()!.getAttribute('aria-modal')).toBe('true');
  });

  it('follows a target that MOVES with its size untouched (a layout shift above it)', async () => {
    const watchers: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          watchers.push(cb);
        }
        observe() {}
        disconnect() {}
      }
    );
    try {
      await setUp();
      click('[data-guide-next]');
      expect(spotOffset()).toEqual({ x: '-6px', y: '790px' });
      // The rendered copy of `nav.posts` shifts up 40px; its size is the same, so no ResizeObserver
      // fires - only the move follower can tell the overlay.
      const el = [
        ...document.querySelectorAll<HTMLElement>('[data-guide-anchor="nav.posts"]'),
      ].find((node) => node.getClientRects().length > 0)!;
      el.getBoundingClientRect = () => new DOMRect(0, 756, 97, 48);
      const watcher = watchers[watchers.length - 1];
      watcher([{ intersectionRatio: 1 } as IntersectionObserverEntry], {} as never); // at observation
      watcher([{ intersectionRatio: 0.5 } as IntersectionObserverEntry], {} as never); // the move
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      flushSync();
      expect(spotOffset()).toEqual({ x: '-6px', y: '750px' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('mimes the swipe on the camera step, which has no control', async () => {
    await setUp();
    for (let i = 0; i < 3; i++) click('[data-guide-next]');
    expect(stepId()).toBe('camera');
    expect(document.querySelector('[data-guide-spotlight]')).toBeNull();
    expect(document.querySelector('[data-guide-gesture="swipe-right"] [data-play]')).not.toBeNull();
  });

  it('moves focus into the bubble and announces each step', async () => {
    await setUp();
    expect(document.activeElement).toBe(bubble());
    const live = document.querySelector('[data-guide-live]')!;
    expect(live.textContent).toContain('1');
    click('[data-guide-next]');
    expect(document.activeElement).toBe(bubble());
    expect(live.textContent).toContain('2');
  });

  it('steps with the arrow keys and ends on Esc, recorded as seen', async () => {
    await setUp();
    key('ArrowRight');
    expect(stepId()).toBe('feed');
    key('ArrowLeft');
    expect(stepId()).toBe('welcome');
    key('Escape');
    expect(bubble()).toBeNull();
    expect(markSeen).toHaveBeenCalledExactlyOnceWith('welcome-tour');
  });

  it('ends on "Passer", always on screen', async () => {
    await setUp();
    click('[data-guide-next]');
    click('[data-guide-skip]');
    expect(bubble()).toBeNull();
    expect(markSeen).toHaveBeenCalledExactlyOnceWith('welcome-tour');
  });

  it('is closed by Back like every overlay - the system Back and the gesture Back', async () => {
    const { history } = await setUp();
    expect(history.historyOverlayStackDepth()).toBe(1);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    flushSync();
    expect(bubble()).toBeNull();
    expect(history.historyOverlayStackDepth()).toBe(0);
    expect(markSeen).toHaveBeenCalledExactlyOnceWith('welcome-tour');

    // The replay, closed by the iOS edge swipe this time.
    const { guideEngine } = await import('$lib/guidance/guidance.svelte');
    guideEngine.request('welcome-tour');
    flushSync();
    expect(stepId()).toBe('welcome');
    expect(history.backHistoryOverlayFromGesture(history.armHistoryOverlayGesture())).toBe(true);
    flushSync();
    expect(bubble()).toBeNull();
  });

  it("publishes its entry to Android's native Back, which closes the tour and not the app", async () => {
    // `MainActivity` reads this depth synchronously: at 0 its Back finishes the activity.
    const depths: number[] = [];
    (window as unknown as Record<string, unknown>).canariBack = {
      setOverlayDepth: (d: number) => depths.push(d),
    };
    const { history } = await setUp();
    expect(bubble()).not.toBeNull();
    expect(depths.at(-1)).toBe(1);

    // The native Back: the page is asked to step its history, and the popstate closes the tour.
    const native = (window as unknown as Record<string, () => boolean>).__canariBackFromNative;
    expect(native()).toBe(true);
    expect(depths.at(-1)).toBe(0);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    flushSync();
    expect(bubble()).toBeNull();
    expect(history.historyOverlayStackDepth()).toBe(0);
    expect(depths.at(-1)).toBe(0);
    expect(markSeen).toHaveBeenCalledExactlyOnceWith('welcome-tour');
  });

  it('is suspended by a call that starts under it, and comes back on the same step after', async () => {
    const { history, session } = await setUp();
    click('[data-guide-next]');
    expect(stepId()).toBe('feed');
    expect(history.historyOverlayStackDepth()).toBe(1);

    session.callState = 'connected';
    flushSync();
    // Hidden and off the history stack - a Back during the call is the call's, never the tour's.
    expect(bubble()).toBeNull();
    expect(history.historyOverlayStackDepth()).toBe(0);
    expect(markSeen).not.toHaveBeenCalled();

    session.callState = 'idle';
    flushSync();
    expect(stepId()).toBe('feed');
    expect(counter()).toBe('2/6');
    expect(history.historyOverlayStackDepth()).toBe(1);
  });

  it('says a modal layer covers the page only while its backdrop is on screen', async () => {
    // Read by the iOS native tab bar, drawn above the WebView, to take no touch meanwhile.
    const { session } = await setUp();
    expect(modalWebLayer.covering).toBe(true);
    session.callState = 'connected';
    flushSync();
    expect(modalWebLayer.covering).toBe(false);
    session.callState = 'idle';
    flushSync();
    expect(modalWebLayer.covering).toBe(true);
    click('[data-guide-skip]');
    expect(modalWebLayer.covering).toBe(false);
  });

  it('is suspended by a Modal that mounts over it, and comes back when it closes', async () => {
    const { history } = await setUp();
    click('[data-guide-next]');
    expect(stepId()).toBe('feed');

    const { default: Modal } = await import('$lib/components/shared/Modal.svelte');
    const host = document.body.appendChild(document.createElement('div'));
    const modal = sv.mount(Modal, {
      target: host,
      props: { open: true, title: 'x', onClose: () => {} },
    });
    flushSync();
    expect(bubble()).toBeNull();
    expect(markSeen).not.toHaveBeenCalled();

    sv.unmount(modal);
    flushSync();
    expect(stepId()).toBe('feed');
    expect(counter()).toBe('2/6');
    // Its own entry is back, alone: the Modal's went with it.
    expect(history.historyOverlayStackDepth()).toBe(1);
  });

  it('leaves the history stack when it ends from its own button', async () => {
    const { history } = await setUp();
    click('[data-guide-skip]');
    expect(history.historyOverlayStackDepth()).toBe(0);
  });

  it('does not start over a surface that covers the screen', async () => {
    await setUp({ covered: true });
    expect(bubble()).toBeNull();
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('does not start again once seen', async () => {
    seen.ids.add('welcome-tour');
    await setUp();
    expect(bubble()).toBeNull();
  });

  it('starts no infinite motion under prefers-reduced-motion', async () => {
    await setUp({ reducedMotion: true });
    expect(document.querySelector('[data-guide-overlay]')!.getAttribute('data-motion')).toBe(
      'reduced'
    );
    click('[data-guide-next]');
    expect(document.querySelector('[data-guide-spotlight] [data-pulse]')).toBeNull();
    for (let i = 0; i < 2; i++) click('[data-guide-next]');
    expect(stepId()).toBe('camera');
    expect(document.querySelector('[data-guide-gesture] [data-play]')).toBeNull();
  });
});

describe('the welcome tour on a desktop', () => {
  beforeEach(() => {
    layout.phone = false;
    layout.swipe = false;
  });

  it('walks five steps on the rail and the top bar - no camera, the agenda in the rail', async () => {
    await setUp();
    const visited: string[] = [];
    for (let i = 0; i < 5; i++) {
      visited.push(stepId()!);
      expect(counter()).toBe(`${i + 1}/5`);
      if (stepId() === 'agenda') {
        // The rail's calendar entry (12, 296, 48x48), grown by the halo padding.
        expect(spotOffset().y).toBe('290px');
        expect(document.querySelector('[data-guide-bubble]')!.getAttribute('data-side')).toBe(
          'right'
        );
      }
      click('[data-guide-next]');
    }
    expect(visited).toEqual(['welcome', 'feed', 'chats', 'agenda', 'profile']);
    expect(markSeen).toHaveBeenCalledExactlyOnceWith('welcome-tour');
  });
});
