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
import {
  clearHistoryOverlayStack,
  historyOverlayStackDepth,
  initHistoryOverlayStack,
  pushHistoryOverlay,
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

beforeEach(() => {
  // A phone layout: the swipe is armed.
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: true,
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

/** One left-edge swipe past the threshold, committed on the panel's slide-out end. */
function edgeSwipe(panel: HTMLElement) {
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

  it("with no overlay on the stack, the swipe is the conversation's own Back", () => {
    const onBack = vi.fn();
    const panel = mountArea(onBack);

    edgeSwipe(panel);

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
