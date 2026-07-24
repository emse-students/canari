import {
  pushHistoryOverlay,
  closeHistoryOverlayFromUi,
  clearHistoryOverlayStack,
  initHistoryOverlayStack,
  historyOverlayStackDepth,
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
    initHistoryOverlayStack();
    pushHistoryOverlay(close);
    const handler = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'popstate'
    )?.[1] as ((e: PopStateEvent) => void) | undefined;
    handler?.({ state: null } as PopStateEvent);
    expect(close).toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(0);
  });

  it('uses history.back when closing from UI', () => {
    const close = vi.fn();
    pushHistoryOverlay(close);
    closeHistoryOverlayFromUi(close);
    expect(history.back).toHaveBeenCalled();
  });
});
