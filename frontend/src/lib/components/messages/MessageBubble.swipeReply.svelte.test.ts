/**
 * THE GESTURE, WIRED TO A POINTER - which is the half that was broken for six months.
 *
 * `messageSwipeReply.test.ts` proves the maths: which delta triggers a reply and which
 * direction belongs to which side of the thread (the reaction swipe it also covered is gone). Every one of those tests
 * passed the whole time the feature was dead, because the component gated all of them behind
 * `supportsHover`, a `$state(true)` nothing ever wrote to. A pure function cannot notice that its
 * only caller never calls it.
 *
 * So these tests mount the real bubble and dispatch real pointer and touch events at the real
 * element. They assert on `onReply` being called - the thing the reader is actually after - and
 * they run with `(pointer: coarse)` matching, which is what a phone reports.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

// The bubble's import graph reaches the app-wide chat singleton, which builds a MediaService at
// module load. None of that is under test here - the gesture is - so the singleton is stubbed
// down to the one function this subtree actually calls.
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  appendLog: () => {},
  getGlobalChat: () => null,
}));

import MessageBubble from './MessageBubble.svelte';
import { REPLY_SWIPE_TRIGGER_PX } from '$lib/utils/messageSwipeReply';

const mounted: (() => void)[] = [];

/** Listeners registered by `onCoarsePointerChange`, so a test can play a pointer change. */
let coarseListeners: ((e: { matches: boolean }) => void)[] = [];

/**
 * Pretends the primary pointer is a finger. This is the ONE fact the dead gate got wrong, so it is
 * installed explicitly rather than inherited from the test environment's defaults.
 */
function stubPointer(coarse: boolean): void {
  coarseListeners = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('coarse') ? coarse : false,
      media: query,
      addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) =>
        coarseListeners.push(fn),
      removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => {
        coarseListeners = coarseListeners.filter((l) => l !== fn);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

interface Harness {
  reply: Mock<(id: string) => void>;
  react: Mock<(id: string, emoji: string) => void>;
}

function mountBubble(props: Record<string, unknown> = {}): Harness {
  const h: Harness = {
    reply: vi.fn<(id: string) => void>(),
    react: vi.fn<(id: string, emoji: string) => void>(),
  };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageBubble, {
    target,
    props: {
      messageId: 'm1',
      senderId: 'u-other',
      currentUserId: 'u-me',
      content: JSON.stringify({ kind: 'text', text: 'hello' }),
      timestamp: new Date('2026-09-20T10:00:00Z'),
      isOwn: false,
      isMobile: true,
      onReply: h.reply,
      onReact: h.react,
      ...props,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return h;
}

function bubble(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-swipe-reply]');
  if (!el) throw new Error('bubble not found');
  return el;
}

/**
 * The element the drag actually MOVES, which stopped being the bubble on 2026-09-22.
 *
 * A quoted message is now a second bubble stacked above this one, so the transform sits on the
 * wrapper holding both - drag the bubble alone and a reply tears in half mid-gesture. The gesture
 * is still listened for on the bubble, which is why `bubble()` above is unchanged.
 */
function dragged(): HTMLElement {
  const el = bubble().parentElement;
  if (!el) throw new Error('stack wrapper not found');
  return el;
}

/** happy-dom may not implement `PointerEvent`; a mouse event carrying the two fields is equivalent. */
function pointer(type: string, x: number, y: number, pointerType = 'touch'): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  return e;
}

/** A touch event carrying one contact point - the path a real finger takes on Android. */
function touch(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = [{ clientX: x, clientY: y }];
  Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  return e;
}

/** Press, drag and release with a pointer, in the three events the component listens for. */
function swipeWithPointer(from: number, to: number, y = 200, pointerType = 'touch'): void {
  const el = bubble();
  el.dispatchEvent(pointer('pointerdown', from, y, pointerType));
  flushSync();
  el.dispatchEvent(pointer('pointermove', to, y, pointerType));
  flushSync();
  el.dispatchEvent(pointer('pointerup', to, y, pointerType));
  flushSync();
}

beforeEach(() => {
  vi.useFakeTimers();
  stubPointer(true);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('MessageBubble - the swipe reaches onReply', () => {
  it('REPLIES on a drag toward the centre of the thread, which is what was dead until 2026-09-20', () => {
    const h = mountBubble();
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20);

    expect(h.reply).toHaveBeenCalledWith('m1');
  });

  it('replies through a real touch sequence too - the non-passive touchmove path', () => {
    const h = mountBubble();
    const el = bubble();
    el.dispatchEvent(touch('touchstart', 100, 200));
    flushSync();
    el.dispatchEvent(touch('touchmove', 100 + REPLY_SWIPE_TRIGGER_PX + 20, 200));
    flushSync();
    el.dispatchEvent(touch('touchend', 100 + REPLY_SWIPE_TRIGGER_PX + 20, 200));
    flushSync();

    expect(h.reply).toHaveBeenCalledWith('m1');
  });

  it('drags the bubble while the finger is down, so the gesture is visible before it commits', () => {
    mountBubble();
    const el = bubble();
    el.dispatchEvent(pointer('pointerdown', 100, 200));
    flushSync();
    el.dispatchEvent(pointer('pointermove', 140, 200));
    flushSync();

    expect(dragged().getAttribute('style') ?? '').toContain('translate3d');
  });

  it('takes an OWN message the other way - a yellow bubble swipes left', () => {
    const h = mountBubble({ isOwn: true, senderId: 'u-me' });
    swipeWithPointer(300, 300 - REPLY_SWIPE_TRIGGER_PX - 20);

    expect(h.reply).toHaveBeenCalledWith('m1');
  });

  it('ignores a drag too short to be a decision', () => {
    const h = mountBubble();
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX - 20);

    expect(h.reply).not.toHaveBeenCalled();
  });

  it('ignores a vertical drag - scrolling a thread must not answer a message', () => {
    const h = mountBubble();
    const el = bubble();
    el.dispatchEvent(pointer('pointerdown', 100, 200));
    flushSync();
    el.dispatchEvent(pointer('pointermove', 104, 400));
    flushSync();
    el.dispatchEvent(pointer('pointerup', 104, 400));
    flushSync();

    expect(el.getAttribute('style') ?? '').not.toContain('translate3d');
    expect(h.reply).not.toHaveBeenCalled();
  });
});

describe('MessageBubble - the outward swipe is a NON-GESTURE, and that is the point', () => {
  // It used to open the reaction tray. The user cut it on 2026-09-22 - *"swiper pour reagir n'est
  // pas quelque chose de bien, c'est meme assez bizarre"* - after it was measured against Messenger
  // 579.0.0.61.91 on the same handset, where an outward drag produces no displacement at all on
  // either side of the thread. These tests exist because a deleted gesture is exactly the kind of
  // thing a later refactor quietly restores: they fail the day the bubble moves outward again.
  it('does not react when a received bubble is dragged AWAY from the centre', () => {
    const h = mountBubble();
    swipeWithPointer(300, 300 - REPLY_SWIPE_TRIGGER_PX - 20);

    expect(h.react).not.toHaveBeenCalled();
    expect(h.reply).not.toHaveBeenCalled();
  });

  it('does not react when an OWN bubble is dragged away from the centre either', () => {
    const h = mountBubble({ isOwn: true, senderId: 'u-me' });
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20);

    expect(h.react).not.toHaveBeenCalled();
    expect(h.reply).not.toHaveBeenCalled();
  });

  it('does not even MOVE the bubble outward - the finger meets no affordance at all', () => {
    mountBubble();
    const el = bubble();
    el.dispatchEvent(pointer('pointerdown', 300, 200));
    flushSync();
    el.dispatchEvent(pointer('pointermove', 300 - REPLY_SWIPE_TRIGGER_PX - 20, 200));
    flushSync();

    expect(el.getAttribute('style') ?? '').not.toContain('translate3d');
  });
});

describe('MessageBubble - the reply hint is revealed, never driven over', () => {
  // The hint is absolutely positioned and does NOT move; the bubble does. Put it on the side the
  // bubble travels TOWARD and the message slides underneath it, which is what the user reported:
  // *"une bulle avec le logo repondre, mais a l'interieur et qui ne bouge pas ... le message passe
  // dessous"*. `right-full` on a received bubble anchors it past the LEFT edge - the side the drag
  // comes from, and the space the bubble vacates. Asserting the class is what pins the SIDE; no
  // jsdom layout is involved, so this is the only honest way to state it.
  it('anchors past the LEFT edge of a received bubble, which is where the drag came from', () => {
    mountBubble();
    const el = bubble();
    el.dispatchEvent(pointer('pointerdown', 100, 200));
    flushSync();
    el.dispatchEvent(pointer('pointermove', 140, 200));
    flushSync();

    const hint = document.querySelector('[aria-hidden="true"].rounded-full');
    expect(hint?.className).toContain('right-full');
    expect(hint?.className).not.toContain('left-full');
  });

  it('anchors past the RIGHT edge of an own bubble, mirrored for the same reason', () => {
    mountBubble({ isOwn: true, senderId: 'u-me' });
    const el = bubble();
    el.dispatchEvent(pointer('pointerdown', 300, 200));
    flushSync();
    el.dispatchEvent(pointer('pointermove', 260, 200));
    flushSync();

    const hint = document.querySelector('[aria-hidden="true"].rounded-full');
    expect(hint?.className).toContain('left-full');
    expect(hint?.className).not.toContain('right-full');
  });
});

describe('MessageBubble - what the gesture still refuses', () => {
  it('does nothing with a MOUSE, whatever the media query says', () => {
    const h = mountBubble();
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20, 200, 'mouse');

    expect(h.reply).not.toHaveBeenCalled();
  });

  it('does nothing on a fine-pointer device - a desktop drag selects text', () => {
    stubPointer(false);
    const h = mountBubble();
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20);

    expect(h.reply).not.toHaveBeenCalled();
  });

  it('does nothing on a tombstone - there is nothing to quote', () => {
    const h = mountBubble({ isDeleted: true });
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20);

    expect(h.reply).not.toHaveBeenCalled();
  });

  it('does nothing on a system pill', () => {
    const h = mountBubble({
      isSystem: true,
      content: JSON.stringify({ kind: 'system', text: 'joined' }),
    });

    // A system message renders no swipeable bubble at all; if it ever does, it must stay inert.
    const el = document.querySelector<HTMLElement>('[data-swipe-reply]');
    if (el) swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20);
    expect(h.reply).not.toHaveBeenCalled();
  });
});

describe('MessageBubble - the pointer kind is re-read, never assumed', () => {
  it('starts working the moment a device reports a coarse pointer', () => {
    stubPointer(false);
    const h = mountBubble();

    // Device emulation toggled on, or a tablet's keyboard folded away.
    coarseListeners.forEach((fn) => fn({ matches: true }));
    flushSync();
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20);

    expect(h.reply).toHaveBeenCalledWith('m1');
  });

  it('stops working the moment a mouse arrives', () => {
    const h = mountBubble();
    coarseListeners.forEach((fn) => fn({ matches: false }));
    flushSync();
    swipeWithPointer(100, 100 + REPLY_SWIPE_TRIGGER_PX + 20);

    expect(h.reply).not.toHaveBeenCalled();
  });
});
