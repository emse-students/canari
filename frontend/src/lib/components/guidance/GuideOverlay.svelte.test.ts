// @vitest-environment happy-dom
/**
 * THE WELCOME TOUR ON THE REAL OVERLAY, ON BOTH LAYOUTS: it starts when the route has settled and
 * the app is quiet, points at the control the layout draws, says "n/N", moves focus into its bubble,
 * announces each step, and ends - recorded as seen - by Next, "Passer", Esc and Back. It does not
 * start over a covering surface, and it drops its infinite motion under `prefers-reduced-motion`.
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

vi.mock('$app/navigation', () => ({
  afterNavigate: (cb: NavCallback) => nav.after.push(cb),
  beforeNavigate: (cb: NavCallback) => nav.before.push(cb),
  goto: async () => {},
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/posts') } }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: true, callState: 'idle' },
}));
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u1', isGlobalAdmin: () => false }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  isBelowMinClientVersion: () => false,
  isMaintenanceBlockingCurrentUser: () => false,
}));
vi.mock('$lib/stores/keyboardViewport.svelte', () => ({
  getKeyboardViewport: () => ({ isOpen: false }),
}));
vi.mock('$lib/components/navigation/NativeTabBar.svelte', () => ({
  nativeTabBar: { status: 'pending' },
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
    markSeen,
    load: async () => {},
  },
  resetSeenHelps: () => {},
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
  return { history, engine: (await import('$lib/guidance/guidance.svelte')).guideEngine };
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
});

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
    const spot = document.querySelector<HTMLElement>('[data-guide-spotlight]')!;
    // The bar's first tab (0, 796, 97x48), grown by the 0.375rem halo padding.
    expect(spot.style.left).toBe('-6px');
    expect(spot.style.top).toBe('790px');
    expect(document.querySelector('[data-guide-blocker]')).not.toBeNull();
    expect(bubble()!.getAttribute('aria-modal')).toBe('true');
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
        const spot = document.querySelector<HTMLElement>('[data-guide-spotlight]')!;
        // The rail's calendar entry (12, 296, 48x48), grown by the halo padding.
        expect(spot.style.top).toBe('290px');
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
