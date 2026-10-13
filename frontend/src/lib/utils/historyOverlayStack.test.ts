import {
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
    back() {
      if (index === 0) return;
      index--;
      queueMicrotask(() => listener?.({ state: entries[index] } as PopStateEvent));
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
