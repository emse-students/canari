// @vitest-environment happy-dom
/**
 * F6 - THE FIRST FRAME OF AN ENTRY MOUNTS THE VIEWPORT TAIL, AND THE WIDEN DOES NOT MOVE THE READER.
 *
 * happy-dom lays nothing out, so the scroller's geometry is MODELLED: every mounted row is
 * `ROW_PX` tall and the pane is `PANE_PX` tall - a phone thread of one-line messages. What is
 * asserted is the component's own arithmetic over that model: how many rows the hidden entry
 * frame mounts, how many the widen adds, and where it leaves `scrollTop`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatArea from './ChatArea.svelte';
import type { ChatMessage, Conversation } from '$lib/types';

/** Sender heads ask for a name and an avatar over HTTP; neither is what the entry window is about. */
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async (id: string) => id,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const PANE_PX = 700;
const ROW_SELECTOR = '[id^="msg-"]';

/**
 * Rows in the thread: the smallest count above the 60-row entry window, which is all the window's
 * arithmetic needs (a window of anything but 60 reads differently). This test used to cross the 5 s
 * timeout under suite load because ChatArea's mount cost grew with the WHOLE thread. The cause was
 * the component, not the size: the first render mounted every row before the entry frame cut it
 * to 20, which the first case below now pins. docs/wiki/test-suite-reform.md (WP-T9).
 */
const THREAD = 61;

let rowPx = 36;
const mounted: (() => void)[] = [];
const restore: (() => void)[] = [];

function modelGeometry() {
  const proto = HTMLElement.prototype;
  const sh = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  const ch = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelectorAll(ROW_SELECTOR).length * rowPx;
    },
  });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => PANE_PX });
  restore.push(() => {
    delete (proto as unknown as Record<string, unknown>).scrollHeight;
    delete (proto as unknown as Record<string, unknown>).clientHeight;
    if (sh) Object.defineProperty(Element.prototype, 'scrollHeight', sh);
    if (ch) Object.defineProperty(Element.prototype, 'clientHeight', ch);
  });
}

function conversationOf(count: number): Conversation {
  const base = Date.UTC(2026, 9, 14, 8, 0, 0);
  const messages: ChatMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `m${String(i).padStart(4, '0')}`,
    senderId: i % 2 ? 'alice' : 'bob',
    content: `message ${i}`,
    timestamp: new Date(base + i * 1000),
    isOwn: false,
  }));
  return {
    id: 'g1',
    name: 'Salon',
    contactName: 'g1',
    messages,
    lifecycle: 'active',
    mlsStateHex: null,
  } as Conversation;
}

function mountArea(count: number) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatArea, {
    target,
    props: {
      conversation: conversationOf(count),
      messageText: '',
      onMessageChange: () => {},
      bindDraftWriter: () => () => {},
      onSend: () => {},
      onInviteMembers: () => {},
    },
  });
  flushSync();
  mounted.push(() => {
    void unmount(app);
    target.remove();
  });
  return target;
}

/**
 * THE ENTRY'S CLOCK IS FAKE, SO THE TEST CHECKS ARITHMETIC AND NOT SPEED. The widen waits behind
 * `scrollToBottomSettled` (animation frames, 250 and 600 ms re-pins) and `yieldToMainThread`; on
 * real timers a loaded runner starves them and the wait outlasts any timeout. Frames and timers are
 * advanced explicitly instead, so the result cannot depend on how busy the machine is.
 */
async function settleEntry() {
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(100);
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
  });
});

afterEach(() => {
  vi.useRealTimers();
  mounted.splice(0).forEach((f) => f());
  restore.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});

describe('ChatArea entry window (F6)', () => {
  it('never mounts more than the 20-row entry frame on mount, whatever the thread holds', () => {
    // The DOM after the flush shows 20 rows either way. What this pins is every row that EXISTED,
    // because the first render used to mount the whole thread and drop all but 20 of them in the
    // same flush - so the rows dropped are read from the removals.
    const rows = new Set<string>();
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });
    const target = mountArea(THREAD);
    for (const r of observer.takeRecords()) {
      for (const n of [...r.addedNodes, ...r.removedNodes]) {
        if (!(n instanceof Element)) continue;
        for (const row of [n, ...n.querySelectorAll(ROW_SELECTOR)]) {
          if (row.matches(ROW_SELECTOR)) rows.add(row.id);
        }
      }
    }
    observer.disconnect();
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(20);
    expect(rows.size).toBe(20);
  });

  it('a thread of one-line rows fills the pane by its own measure, then widens to 60 after the reveal', async () => {
    // 20 one-line rows (720 px) miss the 700 + 40 px a scroll needs by 20 px. The hidden frame adds
    // what the measure asks for (the 4-group floor), NOT the full 60 - which was one 260 ms task on
    // the Mi 9T - and the widen brings the rest after the reveal, a few rows per task.
    rowPx = 36;
    modelGeometry();
    const target = mountArea(THREAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(24);
    await settleEntry();
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(60);
  });

  it('mounts 20 rows first, widens to 60, and moves scrollTop by exactly the height added', async () => {
    rowPx = 48; // 20 rows = 960 px: the viewport is filled, no fill step.
    modelGeometry();
    const target = mountArea(THREAD);
    const scroller = () =>
      target
        .querySelector<HTMLElement>(ROW_SELECTOR)
        ?.closest<HTMLElement>('[class*="overflow-y"]') ?? null;
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(20);
    const el = scroller();
    expect(el).not.toBeNull();
    const heightBefore = el!.scrollHeight;
    await settleEntry();
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(60);
    expect(el!.scrollHeight - heightBefore).toBe(40 * rowPx);
    // The rows under the eye are the same: the reader is still at the bottom of the taller list.
    expect(el!.scrollTop).toBe(el!.scrollHeight);
  });
});
