// @vitest-environment happy-dom
/**
 * One tap opens the info panel, two taps like - NEVER BOTH (user, 2026-10-12).
 *
 * The first tap used to open the panel at once and the second to like and close it, so every heart
 * flashed the readers' panel. The single tap now waits out the double-tap window, so this file counts
 * outcomes per gesture on fake timers: the window is a TIMER, never a wall clock read here.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));
const openExternal = vi.fn(async () => {});
// `isTauriRuntime`: the long-press sheet asks whether a share sheet exists (`canShareOut`).
vi.mock('$lib/utils/openExternal', () => ({
  openExternal: () => openExternal(),
  isTauriRuntime: () => false,
}));
vi.mock('$lib/utils/canariLinkPreview', () => ({
  fetchCanariLinkPreview: async () => null,
  getCachedCanariLinkPreview: () => null,
}));

import MessageBubble from './MessageBubble.svelte';
import { GESTURE } from '$lib/utils/viewerGestures';
import { serializeEnvelope, mkPollEnvelope } from '$lib/envelope';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The info panel flies out when a tap closes it or the bubble unmounts: an outro.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
let reactions: Array<[string, string]> = [];
/** Every time the panel went from hidden to shown, sampled after each step of a gesture. */
let opens = 0;
let wasShown = false;

function infoShown(): boolean {
  return (document.body.textContent ?? '').includes(m.msg_envoye_a());
}

function sample(): void {
  flushSync();
  const shown = infoShown();
  if (shown && !wasShown) opens += 1;
  wasShown = shown;
}

function render(props: Record<string, unknown> = {}): HTMLElement {
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
      onReact: (id: string, emoji: string) => reactions.push([id, emoji]),
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target.querySelector<HTMLElement>('[data-swipe-reply]')!;
}

function tap(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  sample();
}

beforeEach(() => {
  vi.useFakeTimers();
  reactions = [];
  opens = 0;
  wasShown = false;
  openExternal.mockClear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('MessageBubble single tap versus double tap', () => {
  it('a single tap opens the panel once the window has passed, and likes nothing', () => {
    const bubble = render();
    tap(bubble);
    expect(infoShown()).toBe(false); // still waiting: a second tap could arrive
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
    sample();
    expect(opens).toBe(1);
    expect(reactions).toHaveLength(0);
  });

  it('a double tap likes once and never opens the panel', () => {
    const bubble = render();
    tap(bubble);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS - 50);
    sample();
    tap(bubble);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    sample();
    expect(reactions).toEqual([['m1', '❤️']]);
    expect(opens).toBe(0);
  });

  it('a second tap queued behind a slow first one is still a like: the gap is when they happened', () => {
    const bubble = render();
    const click = () => new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    const first = click();
    vi.advanceTimersByTime(100);
    const second = click(); // stamped now, waiting behind the first click's work
    // That work takes 300 ms: the clock moves, and the queued input runs before the window's timer.
    const slow = () => {
      const after = performance.now() + 300;
      vi.spyOn(performance, 'now').mockReturnValue(after);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300);
    };
    // On the mount target, after Svelte's delegated listener there: the work follows the first tap's
    // handling (which stops the click's propagation, so the document would never see it).
    document.body.lastElementChild!.addEventListener('click', slow, { once: true });
    bubble.dispatchEvent(first);
    bubble.dispatchEvent(second);
    vi.restoreAllMocks();
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    sample();
    expect(reactions).toEqual([['m1', '❤️']]);
    expect(opens).toBe(0);
  });

  it('three quick taps are one like and no panel: tap 3 is swallowed by the like it follows', () => {
    const bubble = render();
    tap(bubble);
    vi.advanceTimersByTime(80);
    tap(bubble);
    vi.advanceTimersByTime(80);
    tap(bubble);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    sample();
    expect(reactions).toEqual([['m1', '❤️']]);
    expect(opens).toBe(0);
  });

  it('a context menu (the long press of a phone browser) cancels a pending tap: no panel opens', () => {
    const bubble = render();
    tap(bubble);
    bubble.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    sample();
    expect(opens).toBe(0);
    expect(reactions).toHaveLength(0);
  });

  it('two taps further apart than the window are two single taps, not a like', () => {
    const bubble = render();
    tap(bubble);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
    sample();
    tap(bubble); // closes the panel
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS);
    sample();
    expect(opens).toBe(1);
    expect(infoShown()).toBe(false);
    expect(reactions).toHaveLength(0);
  });

  it('a double tap on a link inside the bubble likes nothing and opens no panel', () => {
    const bubble = render({
      content: JSON.stringify({ kind: 'text', text: 'see https://example.org/page now' }),
    });
    const link = bubble.querySelector('a[href^="https://example.org"]')!;
    expect(link).not.toBeNull();
    tap(link);
    tap(link);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    sample();
    expect(reactions).toHaveLength(0);
    expect(opens).toBe(0);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('two quick taps on a poll option are not a like, and open no panel', () => {
    const bubble = render({
      content: serializeEnvelope(
        mkPollEnvelope(
          'q?',
          [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          false,
          null
        )
      ),
      onVotePoll: () => {},
    });
    const option = bubble.querySelector('button')!;
    expect(option).not.toBeNull();
    tap(option);
    tap(option);
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    sample();
    expect(reactions).toHaveLength(0);
    expect(opens).toBe(0);
  });

  it('on a desktop bubble (no double-tap meaning) the tap opens the panel immediately', () => {
    const bubble = render({ isMobile: false });
    tap(bubble);
    expect(opens).toBe(1);
    expect(reactions).toHaveLength(0);
  });

  it('a bubble unmounted mid-window opens nothing afterwards', () => {
    const bubble = render();
    tap(bubble);
    while (mounted.length) mounted.pop()?.();
    vi.advanceTimersByTime(GESTURE.DOUBLE_TAP_MS * 4);
    sample();
    expect(opens).toBe(0);
  });
});
