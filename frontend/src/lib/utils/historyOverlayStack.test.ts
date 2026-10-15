import {
  abandonHistoryOverlay,
  drainHistoryOverlayStack,
  pushHistoryOverlay,
  closeHistoryOverlayFromUi,
  clearHistoryOverlayStack,
  initHistoryOverlayStack,
  historyOverlayStackDepth,
  releaseHistoryOverlay,
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

  it('uses history.back when closing from UI', () => {
    const close = vi.fn();
    pushHistoryOverlay(close);
    closeHistoryOverlayFromUi(close);
    expect(history.back).toHaveBeenCalled();
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
    // The history is back on the router's entry, so the NEXT Back is the router's to handle.
    expect(h.index).toBe(0);
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

  it('a Back on the router entry after a ghost was crossed is the router own: no second walk', async () => {
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
    // The walk landed on the page's router entry and stopped there: one Back, one thing closed.
    expect(h.index).toBe(2);
  });

  it('a navigation away from a ghost forgets it: a Back from the next page is not read as one on it', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    history.pushState({ sveltekit: 1 }, '');
    const close = vi.fn();
    pushHistoryOverlay(close);
    releaseHistoryOverlay(close);
    // `goto(..., { replaceState: true })` from the ghost: the drain runs, the router replaces it.
    drainHistoryOverlayStack();
    history.replaceState({ sveltekit: 2 }, '');

    await h.pressBack();
    expect(h.index).toBe(1);
  });

  it('an overlay opened in the task that abandons another waits for that traversal: Back then closes only the top (Mi 9T, v1.2.9-alpha.1)', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    const closeCamera = vi.fn();
    const closeTake = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);
    // "Ouvrir la camera": the menu gives its entry back and the camera opens, in ONE task.
    abandonHistoryOverlay(closeMenu);
    pushHistoryOverlay(closeCamera);
    expect(historyOverlayStackDepth()).toBe(2);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // Conversation, camera: the abandon's traversal did not go back off the camera's entry.
    expect(h.index).toBe(2);
    pushHistoryOverlay(closeTake);
    expect(h.index).toBe(3);

    await h.pressBack();
    expect(closeTake).toHaveBeenCalledWith('back');
    expect(closeCamera).not.toHaveBeenCalled();
    expect(closeConversation).not.toHaveBeenCalled();
    expect(h.index).toBe(2);
  });

  it('an overlay held behind a traversal and closed before it landed never writes an entry', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeMenu = vi.fn();
    const closeCamera = vi.fn();
    pushHistoryOverlay(closeMenu);
    abandonHistoryOverlay(closeMenu);
    pushHistoryOverlay(closeCamera);
    closeHistoryOverlayFromUi(closeCamera);
    expect(closeCamera).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(h.index).toBe(0);
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('a back that cannot land (the history first entry) holds nothing: the next overlay gets its entry at once', async () => {
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

  it('a popstate that is not our traversal never ends the hold, and closes the held overlay on screen', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    const closeCamera = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);
    abandonHistoryOverlay(closeMenu);
    pushHistoryOverlay(closeCamera);
    // A landing somewhere our traversal does not go (the router entry): the member's.
    h.fire({ sveltekit: 0 });
    expect(closeCamera).toHaveBeenCalledWith('back');
    // Still held: our traversal has not landed, so nothing was written.
    const closeNext = vi.fn();
    pushHistoryOverlay(closeNext);
    expect(h.index).toBe(2);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    // Ours landed (on the conversation, which that Back had closed, so one walk more): only THEN is
    // the held overlay written, and Back closes it.
    expect(h.index).toBe(1);
    await h.pressBack();
    expect(closeNext).toHaveBeenCalledWith('back');
  });

  it('the member pressing Back while the camera is held closes the camera, not the conversation under it', async () => {
    const h = fakeHistory();
    stop = initHistoryOverlayStack();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    const closeCamera = vi.fn();
    pushHistoryOverlay(closeConversation);
    pushHistoryOverlay(closeMenu);
    abandonHistoryOverlay(closeMenu);
    pushHistoryOverlay(closeCamera);
    // Queued behind our traversal: it lands after the camera's entry was written.
    await h.pressBack();
    expect(closeCamera).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
    expect(h.index).toBe(1);
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
