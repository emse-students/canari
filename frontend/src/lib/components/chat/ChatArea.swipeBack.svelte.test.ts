// @vitest-environment happy-dom
/**
 * THE CONVERSATION'S LEFT-EDGE SWIPE IS A BACK, AND A BACK CLOSES WHAT IS ON TOP.
 *
 * The iOS app has no system Back (its WKWebView does not enable the back-forward swipe): this swipe
 * is the only one. It used to call `onBack` directly, so with the composer's "+" menu open ONE swipe
 * closed the menu AND left the conversation (iPhone 12, v1.2.9-alpha.2, 2 of 2). It now asks the
 * overlay stack first, exactly as Android's Back does.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatArea from './ChatArea.svelte';
import type { Conversation } from '$lib/types';
import { OVERLAY_LAYOUT_QUERY } from '$lib/utils/viewport';
import {
  clearHistoryOverlayStack,
  historyOverlayStackDepth,
  initHistoryOverlayStack,
  pushHistoryOverlay,
  releaseHistoryOverlay,
} from '$lib/utils/historyOverlayStack';

vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async (id: string) => id,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];
let stopStack: () => void = () => {};

/** True for every query but the overlay layout's when a test sets it to false (a wide touch screen). */
let overlayLayout = true;

beforeEach(() => {
  overlayLayout = true;
  // A phone layout: the swipe is armed.
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === OVERLAY_LAYOUT_QUERY ? overlayLayout : true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList
  );
  history.replaceState(null, '');
  stopStack = initHistoryOverlayStack();
});

afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  stopStack();
  clearHistoryOverlayStack();
  vi.restoreAllMocks();
});

function mountArea(onBack: () => void): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatArea, {
    target,
    props: {
      conversation: {
        id: 'g1',
        name: 'Salon',
        contactName: 'g1',
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
      } as unknown as Conversation,
      messageText: '',
      onMessageChange: () => {},
      onSend: () => {},
      onInviteMembers: () => {},
      onBack,
    },
  });
  flushSync();
  mounted.push(() => {
    void unmount(app);
    target.remove();
  });
  return target.querySelector<HTMLElement>('.chat-thread-panel')!;
}

/**
 * One left-edge swipe past the threshold, committed on the panel's slide-out end. `duringStroke`
 * runs after the finger came down and before it lifts.
 */
function edgeSwipe(panel: HTMLElement, duringStroke: () => void = () => {}) {
  for (const [type, clientX] of [
    ['touchstart', 5],
    ['touchmove', 150],
    ['touchend', 150],
  ] as const) {
    if (type === 'touchmove') duringStroke();
    const e = new Event(type, { bubbles: true, cancelable: true });
    const list = [{ clientX, clientY: 300 }];
    Object.defineProperty(e, 'touches', { value: list });
    Object.defineProperty(e, 'changedTouches', { value: list });
    panel.dispatchEvent(e);
  }
  panel.dispatchEvent(new Event('transitionend'));
}

describe('ChatArea edge swipe', () => {
  it('with the "+" menu open, one swipe closes the menu and leaves the conversation open', () => {
    const onBack = vi.fn();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    pushHistoryOverlay(closeConversation);
    const panel = mountArea(onBack);
    pushHistoryOverlay(closeMenu);

    edgeSwipe(panel);

    expect(closeMenu).toHaveBeenCalledWith('back');
    expect(closeConversation).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);

    // The next swipe closes the conversation, through its own entry as Android's Back does.
    edgeSwipe(panel);
    expect(closeConversation).toHaveBeenCalledWith('back');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('a menu closed DURING the stroke spends the swipe: the conversation under it stays (iPhone, alpha.3, 3 of 3)', () => {
    const onBack = vi.fn();
    const closeConversation = vi.fn();
    const closeMenu = vi.fn();
    pushHistoryOverlay(closeConversation);
    const panel = mountArea(onBack);
    pushHistoryOverlay(closeMenu);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Whatever closes the menu while the finger is down (its own tap-outside, a keyboard), it
    // leaves the conversation on top - and the commit used to close that.
    edgeSwipe(panel, () => releaseHistoryOverlay(closeMenu));

    expect(closeConversation).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('gesture Back spent'));

    // The next swipe is a fresh gesture: it closes the conversation.
    edgeSwipe(panel);
    expect(closeConversation).toHaveBeenCalledWith('back');
  });

  it('a transition ending INSIDE the panel does not commit the swipe early', () => {
    const onBack = vi.fn();
    const panel = mountArea(onBack);
    for (const [type, clientX] of [
      ['touchstart', 5],
      ['touchmove', 150],
      ['touchend', 150],
    ] as const) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      const list = [{ clientX, clientY: 300 }];
      Object.defineProperty(e, 'touches', { value: list });
      Object.defineProperty(e, 'changedTouches', { value: list });
      panel.dispatchEvent(e);
    }
    panel.firstElementChild?.dispatchEvent(new Event('transitionend', { bubbles: true }));
    expect(onBack).not.toHaveBeenCalled();
    panel.dispatchEvent(new Event('transitionend'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('on a wide touch screen (no overlay layout, the conversation holds no entry) the swipe is onBack, never the stack top', () => {
    // An iPad in landscape: a community admin panel's entry is on the stack, the conversation's is not.
    overlayLayout = false;
    const onBack = vi.fn();
    const closePanel = vi.fn();
    pushHistoryOverlay(closePanel);
    const panel = mountArea(onBack);

    edgeSwipe(panel);

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(closePanel).not.toHaveBeenCalled();
    expect(historyOverlayStackDepth()).toBe(1);
  });

  it("with no overlay on the stack, the swipe is the conversation's own Back", () => {
    const onBack = vi.fn();
    const panel = mountArea(onBack);

    edgeSwipe(panel);

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
