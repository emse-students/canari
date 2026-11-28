// @vitest-environment happy-dom
/**
 * A PRESS ON A VOICE NOTE'S WAVEFORM IS ITS SCRUBBER'S (owner, 1.8.2): the bubble's
 * long-press action sheet does not open over the scrubber (a `[data-scrub]`), and a sideways
 * drag on it is no reply swipe; the sheet stays reachable from the rest of the bubble.
 *
 * The bubble's sheet is armed on a timer; it is advanced with fake timers, never a wall clock.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));
vi.mock('$lib/utils/openExternal', () => ({
  openExternal: async () => {},
  isTauriRuntime: () => false,
}));
vi.mock('$lib/utils/canariLinkPreview', () => ({
  fetchCanariLinkPreview: async () => null,
  getCachedCanariLinkPreview: () => null,
}));

import MessageBubble from './MessageBubble.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The sheet flies out when the bubble unmounts: an outro.
afterAll(adoptTransitionAnimations());

/** Longer than any long-press arming in the bubble. */
const HELD_MS = 1000;

const mounted: (() => void)[] = [];

function render(): { bubble: HTMLElement; scrub: HTMLElement } {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: 'u-other',
      currentUserId: 'u-me',
      content: JSON.stringify({ kind: 'text', text: 'hello' }),
      timestamp: new Date('2026-10-05T10:00:00Z'),
      isOwn: false,
      isMobile: true,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  const bubble = target.querySelector<HTMLElement>('[data-swipe-reply]')!;
  // The waveform's scrubber, as `VoiceMessagePlayer` mounts it inside the bubble.
  const scrub = document.createElement('div');
  scrub.setAttribute('role', 'slider');
  scrub.setAttribute('data-scrub', '');
  bubble.appendChild(scrub);
  return { bubble, scrub };
}

function hold(el: Element): void {
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'touch',
      clientX: 50,
      clientY: 50,
    })
  );
  // A phone raises `contextmenu` for a touch hold too.
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  vi.advanceTimersByTime(HELD_MS);
  flushSync();
}

const sheetOpen = () =>
  document.querySelector(`[aria-label="${m.msg_close_actions_label()}"]`) !== null;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('MessageBubble - a press on a voice note waveform', () => {
  it('does not open the action sheet: the press is the scrubber', () => {
    const { scrub } = render();
    hold(scrub);
    expect(sheetOpen()).toBe(false);
  });

  it('a hold on the rest of the bubble still opens it', () => {
    const { bubble } = render();
    hold(bubble);
    expect(sheetOpen()).toBe(true);
  });
});
