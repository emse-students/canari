// @vitest-environment happy-dom
import {
  abandonHistoryOverlay,
  armHistoryOverlayGesture,
  backHistoryOverlayFromGesture,
  drainHistoryOverlayStack,
  pushHistoryOverlay,
  closeHistoryOverlayFromUi,
  clearHistoryOverlayStack,
  initHistoryOverlayStack,
  historyOverlayStackDepth,
  releaseHistoryOverlay,
  dropAddressFragment,
} from './historyOverlayStack';

describe('historyOverlayStack', () => {
  beforeEach(() => {
    clearHistoryOverlayStack();
    vi.stubGlobal('history', {
      length: 1,
      state: null,
      pushState: vi.fn(),
      back: vi.fn(),
    });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: true }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pushes state when opening an overlay', () => {
    const close = vi.fn();
    pushHistoryOverlay(close);
    expect(history.pushState).toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
  });

  it('closes top overlay on popstate', () => {
    const close = vi.fn();
    const stop = initHistoryOverlayStack();
    pushHistoryOverlay(close);
    const handler = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'popstate'
    )?.[1] as ((e: PopStateEvent) => void) | undefined;
    handler?.({ state: null } as PopStateEvent);
    expect(close).toHaveBeenCalledWith('back');
    expect(historyOverlayStackDepth()).toBe(0);
    stop();
  });

  it('a UI close closes at once and never traverses: the entry stays, as a ghost', () => {
    const close = vi.fn();
    pushHistoryOverlay(close);
    closeHistoryOverlayFromUi(close);
    expect(close).toHaveBeenCalledTimes(1);
    expect(historyOverlayStackDepth()).toBe(0);
    expect(history.back).not.toHaveBeenCalled();
  });

  it('releasing an overlay its owner closed empties the stack and never walks the history', () => {
    const close = vi.fn();
    pushHistoryOverlay(close);
    releaseHistoryOverlay(close);
    expect(historyOverlayStackDepth()).toBe(0);
    expect(history.back).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    // Idempotent: a dismissal that went through the stack already removed it.
    releaseHistoryOverlay(close);
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('a drain tells each handler the app is navigating, so none may ask', () => {
    const reasons: (string | undefined)[] = [];
    pushHistoryOverlay((reason) => reasons.push(reason));
    drainHistoryOverlayStack();
    expect(reasons).toEqual(['navigation']);
    expect(historyOverlayStackDepth()).toBe(0);
  });
});

/**
 * A history that behaves like the browser's: entries, a pointer, `pushState` truncating what is
 * forward of it, and `back()` landing ASYNCHRONOUSLY with a `popstate` carrying the landed state.
 */
function fakeHistory() {
  const entries: unknown[] = [{ sveltekit: 0 }];
  let index = 0;
  let listener: ((e: PopStateEvent) => void) | undefined;
  const api = {
    get length() {
      return entries.length;
    },
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.splice(index + 1);
      entries.push(state);
      index = entries.length - 1;
    },
    replaceState(state: unknown) {
      entries[index] = state;
    },
    back() {
      // The pointer moves when the traversal RUNS, not when it is asked for: a `pushState` made in
      // between is gone back off, as Chrome does.
      queueMicrotask(() => {
        if (index === 0) return;
        index--;
        listener?.({ state: entries[index] } as PopStateEvent);
      });
    },
  };
  vi.stubGlobal('history', api);
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: PopStateEvent) => void) => {
      if (type === 'popstate') listener = fn;
    },
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: true }),
  });
  return {
    get index() {
      return index;
    },
    /** The system Back: the pointer moves down one entry and the page hears about it. */
    async pressBack() {
      api.back();
      // Every landing may walk one more entry; let each one settle.
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
    /** A `popstate` landing on `state`, delivered now, with no traversal behind it. */
    fire(state: unknown) {
      listener?.({ state } as PopStateEvent);
    },
  };
}

describe('historyOverlayStack - one Back closes what is on screen (Mi 9T, 2026-10-13)', () => {
  let stop: () => void = () => {};
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it('closes the message sheet and leaves the conversation open under it', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeSheet = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeSheet);

    await h.pressBack();
    expect(closeSheet).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);

    await h.pressBack();
    expect(closeConversation).toHaveBeenCalledWith('back');
    expect(h.index).toBe(0);
  });

  it('a sheet closed by a tapped action costs no Back: the next one closes the conversation', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeSheet = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeSheet);
    // "Repondre": the owner sets its state, and the sheet's entry is left behind as a ghost.
    releaseHistoryOverlay(closeSheet);

    await h.pressBack();
    expect(closeConversation).toHaveBeenCalledTimes(1);
    expect(closeSheet).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(0);
    // Landed on the conversation's own entry, now a ghost: closing never traverses.
    expect(h.index).toBe(1);
  });

  it('a ghost between two live overlays is crossed without costing a Back', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeSheet = vi.fn();
    const closePicker = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeSheet);
    releaseHistoryOverlay(closeSheet); // the sheet hands over to the emoji picker
    pushHistoryOverlay(closePicker);

    await h.pressBack();
    expect(closePicker).toHaveBeenCalledTimes(1);
    expect(closeConversation).not.toHaveBeenCalled();

    await h.pressBack();
    expect(closeConversation).toHaveBeenCalledTimes(1);
    expect(h.index).toBe(0);
  });

  it('a Back pressed on a ghost with nothing open still leaves the page (a picker closed on its choice)', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    // The page is the SECOND router entry: a Back on it goes to the previous page.
    history.pushState({ sveltekit: 1 }, '');
    const closePicker = vi.fn();
    pushHistoryOverlay(closePicker);
    releaseHistoryOverlay(closePicker); // the choice closes the sheet through its owner's state

    await h.pressBack();
    expect(closePicker).not.toHaveBeenCalled();
    // On the previous page, not on this page's own entry with the press spent on the ghost.
    expect(h.index).toBe(0);
  });

  it('once the last overlay is closed, ONE Back leaves the page across the ghosts it left', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    history.pushState({ sveltekit: 1 }, '');
    history.pushState({ sveltekit: 2 }, '');
    const closeConversation = vi.fn();
    const closeSheet = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeSheet);
    releaseHistoryOverlay(closeSheet);

    await h.pressBack();
    expect(closeConversation).toHaveBeenCalledTimes(1);
    expect(h.index).toBe(3);
    // Nothing open: this press is the page's. It lands on the page's entry, which shows nothing new,
    // so the walk goes one further - the previous page, in one press.
    await h.pressBack();
    expect(h.index).toBe(1);
  });

  it('a navigation away from a ghost forgets it: a Back from the next page is not read as one on it', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    history.pushState({ sveltekit: 1 }, '');
    const close = vi.fn();
    pushHistoryOverlay(close);
    releaseHistoryOverlay(close);
    // `goto(..., { replace: true })` from the ghost: the drain runs, the router replaces it.
    drainHistoryOverlayStack();
    history.replaceState({ sveltekit: 2 }, '');

    await h.pressBack();
    expect(h.index).toBe(1);
  });

  it('an overlay opened in the task that abandons another TAKES its entry: Back then closes only the top (Mi 9T, v1.2.9-alpha.1)', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    const closeCamera = vi.fn();
    const closeTake = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);
    // "Ouvrir la camera": the menu gives its entry up and the camera opens, in ONE task.
    abandonHistoryOverlay(closeMenu);
    pushHistoryOverlay(closeCamera);
    expect(historyOverlayStackDepth()).toBe(2);
    // Conversation, camera: the camera replaced the menu's entry, nothing traversed.
    expect(h.index).toBe(2);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.index).toBe(2);
    pushHistoryOverlay(closeTake);
    expect(h.index).toBe(3);

    await h.pressBack();
    expect(closeTake).toHaveBeenCalledWith('back');
    expect(closeCamera).not.toHaveBeenCalled();
    expect(closeConversation).not.toHaveBeenCalled();
    expect(h.index).toBe(2);
  });

  it('the camera handed back (take, then camera, abandoned): a sheet then one Back closes only the sheet', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeCamera = vi.fn();
    const closeTake = vi.fn();
    const closeSheet = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeCamera);
    pushHistoryOverlay(closeTake);
    // "Suivant": the take is abandoned and the camera's onclose runs; its onDestroy abandons it.
    abandonHistoryOverlay(closeTake);
    abandonHistoryOverlay(closeCamera);
    expect(historyOverlayStackDepth()).toBe(1);
    pushHistoryOverlay(closeSheet);
    expect(h.index).toBe(3);

    await h.pressBack();
    expect(closeSheet).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
    await h.pressBack();
    expect(closeConversation).toHaveBeenCalledWith('back');
    expect(closeCamera).not.toHaveBeenCalled();
    expect(closeTake).not.toHaveBeenCalled();
  });

  it('a conversation selected with the drawer AND the side panel open takes their entries: one Back closes it', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeDrawer = vi.fn();
    const closePanel = vi.fn();
    const closeConversation = vi.fn();
    pushHistoryOverlay(closeDrawer);
    pushHistoryOverlay(closePanel);
    // selectConversation: both give their entries up, and the conversation opens, in one task.
    abandonHistoryOverlay(closeDrawer);
    abandonHistoryOverlay(closePanel);
    pushHistoryOverlay(closeConversation);
    expect(h.index).toBe(2);

    await h.pressBack();
    expect(closeConversation).toHaveBeenCalledWith('back');
    expect(closeDrawer).not.toHaveBeenCalled();
    expect(closePanel).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('pushA pushB abandonB abandonA: nothing traverses, and the next overlay is closed by ONE Back', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const a = vi.fn();
    const b = vi.fn();
    pushHistoryOverlay(a);
    pushHistoryOverlay(b);
    abandonHistoryOverlay(b);
    abandonHistoryOverlay(a);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.index).toBe(2);
    expect(historyOverlayStackDepth()).toBe(0);

    const c = vi.fn();
    pushHistoryOverlay(c);
    expect(h.index).toBe(2);
    await h.pressBack();
    expect(c).toHaveBeenCalledWith('back');
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('pushA pushB uiB uiB: the second close is a no-op, and Back then closes A', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const a = vi.fn();
    let bOpen = true;
    const b = vi.fn(() => {
      bOpen = false;
    });
    pushHistoryOverlay(a);
    pushHistoryOverlay(b);
    closeHistoryOverlayFromUi(b);
    // A double tap: the owner's guard sees the overlay already closed.
    if (bOpen) closeHistoryOverlayFromUi(b);
    expect(b).toHaveBeenCalledTimes(1);
    expect(historyOverlayStackDepth()).toBe(1);

    await h.pressBack();
    expect(a).toHaveBeenCalledWith('back');
    expect(historyOverlayStackDepth()).toBe(0);
    expect(h.index).toBeGreaterThan(0);
  });

  it('pushA uiA uiA at the first entry: no hold, no traversal, and the next overlay gets an entry at once', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const a = vi.fn();
    pushHistoryOverlay(a);
    closeHistoryOverlayFromUi(a);
    closeHistoryOverlayFromUi(a);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(historyOverlayStackDepth()).toBe(0);
    expect(h.index).toBe(1);

    const next = vi.fn();
    pushHistoryOverlay(next);
    expect(historyOverlayStackDepth()).toBe(1);
    await h.pressBack();
    expect(next).toHaveBeenCalledWith('back');
    expect(h.index).toBe(0);
  });

  it('a Back that lands on the history first entry: the next overlay gets its entry at once', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closePicker = vi.fn();
    pushHistoryOverlay(closePicker);
    releaseHistoryOverlay(closePicker);
    // Back on the ghost lands on the router entry, which is the FIRST one: the walk off it goes
    // nowhere and no popstate ever comes.
    await h.pressBack();
    expect(h.index).toBe(0);

    const closeNext = vi.fn();
    pushHistoryOverlay(closeNext);
    expect(h.index).toBe(1);
    await h.pressBack();
    expect(closeNext).toHaveBeenCalledWith('back');
  });

  it('the member pressing Back right after the camera took the menu entry closes the camera, not the conversation', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    const closeCamera = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);
    abandonHistoryOverlay(closeMenu);
    pushHistoryOverlay(closeCamera);
    await h.pressBack();
    expect(closeCamera).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
    expect(h.index).toBe(1);
  });

  it('the iOS edge swipe with the "+" menu open closes the menu, not the conversation (iPhone 12, v1.2.9-alpha.2)', () => {
    fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);

    expect(backHistoryOverlayFromGesture(armHistoryOverlayGesture())).toBe(true);
    expect(closeMenu).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);

    expect(backHistoryOverlayFromGesture(armHistoryOverlayGesture())).toBe(true);
    expect(closeConversation).toHaveBeenCalledWith('back');
    // Nothing open: the gesture is its owner's again.
    expect(backHistoryOverlayFromGesture(armHistoryOverlayGesture())).toBe(false);
  });

  it('a second commit of one gesture (no arm left) closes nothing - never the menu AND the conversation', () => {
    fakeHistory();
    stop = initHistoryOverlayStack({ systemBack: false });
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);

    // The caller hands its arm over once: the first commit takes it, a second gets null.
    let arm: ReturnType<typeof armHistoryOverlayGesture> | null = armHistoryOverlayGesture();
    const commit = () => {
      const held = arm;
      arm = null;
      return backHistoryOverlayFromGesture(held);
    };
    expect(commit()).toBe(true);
    expect(commit()).toBe(true);
    expect(closeMenu).toHaveBeenCalledTimes(1);
    expect(closeConversation).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
  });

  it('the edge swipe over the camera review closes the take (which asks), then the camera, never the conversation', () => {
    fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeCamera = vi.fn();
    const closeTake = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeCamera);
    pushHistoryOverlay(closeTake);

    backHistoryOverlayFromGesture(armHistoryOverlayGesture());
    expect(closeTake).toHaveBeenCalledWith('back');
    expect(closeCamera).not.toHaveBeenCalled();
    backHistoryOverlayFromGesture(armHistoryOverlayGesture());
    expect(closeCamera).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
  });

  it('a gesture Back leaves a ghost the next overlay takes, and a system Back after it still closes only the top', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);
    backHistoryOverlayFromGesture(armHistoryOverlayGesture());
    const closeSheet = vi.fn();
    pushHistoryOverlay(closeSheet);
    expect(h.index).toBe(2);

    await h.pressBack();
    expect(closeSheet).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
  });

  it('with no system Back (the iOS app) no entry is ever written, so nested closes by swipe leave nothing behind', () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack({ systemBack: false });
    for (let cycle = 0; cycle < 3; cycle++) {
      const closes = [vi.fn(), vi.fn(), vi.fn()];
      for (const close of closes) pushHistoryOverlay(close);
      expect(historyOverlayStackDepth()).toBe(3);
      for (let i = closes.length - 1; i >= 0; i--) {
        expect(backHistoryOverlayFromGesture(armHistoryOverlayGesture())).toBe(true);
        expect(closes[i]).toHaveBeenCalledWith('back');
      }
    }
    expect(historyOverlayStackDepth()).toBe(0);
    // Three cycles of three nested overlays: still the router's one entry.
    expect(history.length).toBe(1);
    expect(h.index).toBe(0);
  });

  it('reads an entry left by an earlier page load as the router entry below every live overlay', () => {
    let listener: ((e: PopStateEvent) => void) | undefined;
    vi.stubGlobal('history', { length: 1, state: null, pushState: vi.fn(), back: vi.fn() });
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: (e: PopStateEvent) => void) => {
        if (type === 'popstate') listener = fn;
      },
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: true }),
    });
    stop = initHistoryOverlayStack();
    const close = vi.fn();
    pushHistoryOverlay(close);
    pushHistoryOverlay(close);
    // Same key, another load's mark (a reload happened with an overlay open): its id means nothing
    // here, and every overlay this load pushed lies above it.
    listener?.({ state: { canariOverlay: 1, canariLoad: 'an-earlier-load' } } as PopStateEvent);
    expect(close).toHaveBeenCalledTimes(2);
    expect(historyOverlayStackDepth()).toBe(0);
    expect(history.back).not.toHaveBeenCalled();
  });
});

describe('dropAddressFragment', () => {
  it('removes the fragment from the address and keeps the entry and its state', () => {
    window.history.replaceState({ kept: 1 }, '', '/c/join/tok?x=1#grant-bytes');
    const length = window.history.length;

    dropAddressFragment();

    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe('/c/join/tok?x=1');
    expect(window.history.state).toEqual({ kept: 1 });
    expect(window.history.length).toBe(length);
  });
});
