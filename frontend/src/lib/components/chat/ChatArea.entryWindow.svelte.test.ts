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
import { OLDER_TRIGGER_PX } from '$lib/utils/chat/renderWindow';
import type { ChatMessage, Conversation } from '$lib/types';

/** Sender heads ask for a name and an avatar over HTTP; neither is what the entry window is about. */
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async (id: string) => id,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
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
/** The pane's height: `PANE_PX`, or 0 for a pane that is not laid out yet. */
let panePx = PANE_PX;
const mounted: (() => void)[] = [];
const restore: (() => void)[] = [];

function modelGeometry() {
  const proto = HTMLElement.prototype;
  const sh = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  const ch = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  // A BROWSER NEVER REPORTS A `scrollHeight` BELOW THE PANE'S `clientHeight`: a short list reads as
  // the pane's own height. The model clamps the same way, so the fill is tested against geometry
  // the DOM can produce (an unclamped model let a fill that measured nothing pass).
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      // A pane that is not laid out (display:none) reports 0 for both, as a browser does.
      if (panePx === 0) return 0;
      return Math.max(this.querySelectorAll(ROW_SELECTOR).length * rowPx, panePx);
    },
  });
  // Rows are stacked from the top of the scroller, `rowPx` each: what the fill measures.
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (!this.matches(ROW_SELECTOR)) return rect!.value.call(this);
      const rows = [
        ...(this.closest('[class*="overflow-y"]')?.querySelectorAll(ROW_SELECTOR) ?? []),
      ];
      const top = rows.indexOf(this) * rowPx;
      return { top, bottom: top + rowPx, left: 0, right: 0, width: 0, height: rowPx, x: 0, y: top };
    },
  });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => panePx });
  restore.push(() => {
    delete (proto as unknown as Record<string, unknown>).scrollHeight;
    delete (proto as unknown as Record<string, unknown>).clientHeight;
    if (sh) Object.defineProperty(Element.prototype, 'scrollHeight', sh);
    if (ch) Object.defineProperty(Element.prototype, 'clientHeight', ch);
    if (rect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect);
  });
}

function conversationOf(count: number, id = 'g1'): Conversation {
  const base = Date.UTC(2026, 9, 14, 8, 0, 0);
  const messages: ChatMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `${id}m${String(i).padStart(4, '0')}`,
    senderId: i % 2 ? 'alice' : 'bob',
    content: `message ${i}`,
    timestamp: new Date(base + i * 1000),
    isOwn: false,
  }));
  return {
    id,
    name: 'Salon',
    contactName: id,
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

/** The same mount with a conversation the test can switch, as the parent page does. */
function mountSwitchable(
  count: number,
  onLoadOlderMessages?: () => Promise<boolean>,
  conversation: Conversation = conversationOf(count, 'g1')
) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({
    conversation,
    messageText: '',
    onMessageChange: () => {},
    bindDraftWriter: () => () => {},
    onSend: () => {},
    onInviteMembers: () => {},
    onLoadOlderMessages,
  });
  const app = mount(ChatArea, { target, props });
  flushSync();
  mounted.push(() => {
    void unmount(app);
    target.remove();
  });
  return { target, props };
}

/** Records the rows mounted at the moment the scroller is next shown (`opacity-100`). */
function rowsAtNextReveal(target: HTMLElement): { readonly rows: number | null; stop(): void } {
  const scroller = target.querySelector<HTMLElement>('.chat-messages-scroll')!;
  let rows: number | null = null;
  const observer = new MutationObserver(() => {
    if (rows === null && scroller.classList.contains('opacity-100')) {
      rows = target.querySelectorAll(ROW_SELECTOR).length;
    }
  });
  observer.observe(scroller, { attributes: true, attributeFilter: ['class'] });
  return {
    get rows() {
      return rows;
    },
    stop: () => observer.disconnect(),
  };
}

/**
 * THE ENTRY'S CLOCK IS FAKE, SO THE TEST CHECKS ARITHMETIC AND NOT SPEED. The widen waits behind
 * `scrollToBottomSettled` (animation frames) and `yieldToMainThread`; on
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
  panePx = PANE_PX;
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
    // 20 one-line rows (720 px) miss the 700 + 120 px the fill aims for by 100 px. The hidden frame
    // adds what the measure asks for (the 4-group floor), NOT the full 60 - which was one 260 ms task
    // on the Mi 9T - and the widen brings the rest after the reveal, a few rows per task.
    rowPx = 36;
    modelGeometry();
    const target = mountArea(THREAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(24);
    await settleEntry();
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(60);
  });

  it.each([34, 36, 37, 40, 44])(
    'rows of %i px: the revealed pane sits past the pagination trigger, so the reveal paginates nothing',
    async (px) => {
      // Pinned to the bottom, scrollTop = overflow. Inside OLDER_TRIGGER_PX the reveal's own scroll
      // event would call loadOlderGroups: one more task of 140 groups.
      rowPx = px;
      modelGeometry();
      const target = mountArea(THREAD);
      await vi.advanceTimersByTimeAsync(0);
      const el = target
        .querySelector<HTMLElement>(ROW_SELECTOR)!
        .closest<HTMLElement>('[class*="overflow-y"]')!;
      expect(el.scrollHeight - PANE_PX).toBeGreaterThanOrEqual(OLDER_TRIGGER_PX);
      await settleEntry();
      expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(60);
    }
  );

  it('reveals the entry frame alone: the widen comes after, never in the reveal flush', async () => {
    // The full-window floor used to come back the moment `entering` fell, so the reveal's own flush
    // clamped the window to 60 and mounted the 40 rows the stepped widen exists to spread out - 60
    // rows at the reveal on the salon-mount bench, 2026-11-07, and the reveal frame paid for them.
    rowPx = 48; // 20 rows = 960 px: the viewport is filled, no fill step.
    modelGeometry();
    const target = mountArea(THREAD);
    const scroller = target.querySelector<HTMLElement>('.chat-messages-scroll')!;
    expect(scroller.classList.contains('opacity-0')).toBe(true);
    let rowsAtReveal: number | null = null;
    const observer = new MutationObserver(() => {
      if (rowsAtReveal === null && scroller.classList.contains('opacity-100')) {
        rowsAtReveal = target.querySelectorAll(ROW_SELECTOR).length;
      }
    });
    observer.observe(scroller, { attributes: true, attributeFilter: ['class'] });
    await settleEntry();
    observer.disconnect();
    expect(rowsAtReveal).toBe(20);
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(60);
  });

  it('a switch during the reveal frame: the retired reveal shows nothing, the new entry reveals 20', async () => {
    // The reveal callback of the FIRST conversation is queued for the next frame; the switch lands
    // before it. That stale callback used to drop `entering` for the NEW conversation with both
    // flags false, so its floor was 60 and its 40 rows mounted in the reveal's flush.
    rowPx = 48;
    modelGeometry();
    const { target, props } = mountSwitchable(THREAD);
    await vi.advanceTimersByTimeAsync(0); // the first entry's fill: its reveal waits on a frame
    props.conversation = conversationOf(THREAD, 'g2');
    flushSync();
    const reveal = rowsAtNextReveal(target);
    await settleEntry();
    reveal.stop();
    expect(reveal.rows).toBe(20);
    const rows = [...target.querySelectorAll(ROW_SELECTOR)];
    expect(rows.length).toBe(60);
    expect(rows.every((r) => r.id.startsWith('msg-g2'))).toBe(true);
  });

  it('a switch after the first widen step: the new conversation still reaches 60', async () => {
    // The retired widen leaves `entryWidening` to the entry that retired it; a flag stuck true
    // would hold the next conversation at the 20-row floor for good.
    rowPx = 48;
    modelGeometry();
    const { target, props } = mountSwitchable(THREAD);
    for (let i = 0; i < 40 && target.querySelectorAll(ROW_SELECTOR).length < 30; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(30);
    props.conversation = conversationOf(THREAD, 'g2');
    flushSync();
    await settleEntry();
    const rows = [...target.querySelectorAll(ROW_SELECTOR)];
    expect(rows.length).toBe(60);
    expect(rows.every((r) => r.id.startsWith('msg-g2'))).toBe(true);
  });

  it('the widen takes no step while a finger is on the thread, and resumes when it lifts', async () => {
    // A step writes `scrollTop`; under a finger that fights the drag (iOS WebKit can cancel it).
    rowPx = 48;
    modelGeometry();
    const target = mountArea(THREAD);
    const scroller = target.querySelector<HTMLElement>('.chat-messages-scroll')!;
    const touch = (type: string, left: number) => {
      const e = new Event(type);
      Object.defineProperty(e, 'touches', { value: { length: left } });
      scroller.dispatchEvent(e);
    };
    touch('touchstart', 1);
    await settleEntry();
    expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(20);
    touch('touchend', 0);
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

  it('writes ONE info-level [CHAT_VIEW] line per entry, with where the pane stands', async () => {
    // The exported log records no debug: this line is what a device reading has of the pane.
    rowPx = 48;
    modelGeometry();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { props } = mountSwitchable(THREAD);
    await settleEntry();
    await settleEntry();
    const entryLines = () =>
      info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('entry settled'));
    expect(entryLines()).toHaveLength(1);
    expect(entryLines()[0]).toMatch(
      /^\[CHAT_VIEW\] g1 entry settled: pinned=true isNearBottom=true /
    );
    expect(entryLines()[0]).toContain(`rows=${THREAD}`);

    props.conversation = conversationOf(THREAD, 'g2');
    flushSync();
    await settleEntry();
    expect(entryLines()).toHaveLength(2);
    expect(entryLines()[1]).toMatch(/^\[CHAT_VIEW\] g2 entry settled: pinned=true /);
  });

  /**
   * AN OLDER-HISTORY LOAD IN FLIGHT ACROSS A SWITCH (review of #3223). Its restore is computed from
   * the conversation it started in; landing on the next one put that one at an arbitrary row, and
   * the entry's 250 / 600 ms re-pins were what used to hide it.
   */
  it('a switch retires the older-history load in flight: its restore never lands on the next one', async () => {
    modelGeometry();
    let answer: (more: boolean) => void = () => {};
    const load = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const { target, props } = mountSwitchable(25, load);
    await settleEntry();
    const scroller = target.querySelector<HTMLElement>('.chat-messages-scroll')!;
    // The reader reaches the top of g1: the window is whole, so the store is asked for more.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(20);
    expect(load).toHaveBeenCalledTimes(1);

    props.conversation = conversationOf(THREAD, 'g2');
    flushSync();
    await settleEntry();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);

    answer(true);
    await settleEntry();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });
});

/**
 * A THREAD SHORTER THAN ITS PANE ASKS FOR ITS PAST AT ENTRY (owner's Pixel 6a, 2026-11-14): such a
 * pane cannot be scrolled, so the older-history load used to wait for the first stray scroll event -
 * a keyboard close - and its spinner and its prepend landed in the middle of that motion.
 */
describe('ChatArea short thread fill', () => {
  /** The newest `held` rows of one 35-row thread: what the store has handed over so far. */
  const FULL = conversationOf(35);
  const newest = (held: number): Conversation => ({
    ...FULL,
    messages: FULL.messages.slice(FULL.messages.length - held),
  });

  it('a short thread with an exhausted store asks it once at entry, with no scroll at all', async () => {
    rowPx = 36; // 5 rows = 180 px in a 700 px pane.
    modelGeometry();
    const load = vi.fn(async () => false);
    mountSwitchable(5, load);
    await settleEntry();
    expect(load).toHaveBeenCalledTimes(1);
    await settleEntry();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps asking while the pane is short, and stops once it overflows', async () => {
    rowPx = 36; // 20 rows (720 px) are the first count past the 700 px pane.
    modelGeometry();
    let held = 5;
    const ref: { props?: { conversation: Conversation } } = {};
    // The store's answer is prepended, as the parent page does: the same newest rows, older above.
    const load = vi.fn(async () => {
      held += 10;
      ref.props!.conversation = newest(held);
      return true;
    });
    ref.props = mountSwitchable(5, load, newest(5)).props;
    await settleEntry();
    await settleEntry();
    // 5 -> 15 (540 px, still short) -> 25 (900 px): two asks, and none once the pane overflows.
    expect(load).toHaveBeenCalledTimes(2);
    expect(held).toBe(25);
  });

  it('a pane with no height yet pages nothing, whatever the store holds (review of #3545)', async () => {
    rowPx = 36;
    panePx = 0; // display:none, a collapsed panel: every pane measures as "short".
    modelGeometry();
    const load = vi.fn(async () => true); // an endless store
    mountSwitchable(5, load);
    await settleEntry();
    await settleEntry();
    expect(load).not.toHaveBeenCalled();
  });

  it('a store page that adds no row does not end the fill: the next page is asked', async () => {
    rowPx = 36;
    modelGeometry();
    // Two pages of nothing shown (a run of hidden events), then the end of the store.
    const answers = [true, true, false];
    const load = vi.fn(async () => answers.shift() ?? false);
    mountSwitchable(5, load);
    await settleEntry();
    await settleEntry();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('the fill is silent: its peer ask shows no spinner and no banner', async () => {
    rowPx = 36;
    modelGeometry();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const ask = vi.fn(() => new Promise<'no-peer'>(() => {}));
    const app = mount(ChatArea, {
      target,
      props: {
        conversation: conversationOf(5),
        messageText: '',
        onMessageChange: () => {},
        bindDraftWriter: () => () => {},
        onSend: () => {},
        onInviteMembers: () => {},
        onLoadOlderMessages: async () => false,
        onRequestOlderFromPeers: ask,
      },
    });
    mounted.push(() => {
      void unmount(app);
      target.remove();
    });
    flushSync();
    await settleEntry();
    await settleEntry();
    expect(ask).toHaveBeenCalledTimes(1);
    // The scrollback banner of an ask in flight is the one `aria-busy` status in the thread.
    expect(target.querySelector('.chat-messages-scroll [aria-busy="true"]')).toBeNull();
  });

  it('a pane the thread already overflows asks nothing at entry', async () => {
    rowPx = 48; // 25 rows = 1200 px.
    modelGeometry();
    const load = vi.fn(async () => false);
    mountSwitchable(25, load);
    await settleEntry();
    await settleEntry();
    expect(load).not.toHaveBeenCalled();
  });
});

/**
 * THE STORE'S PAGE NEVER WRITES A `scrollTop` CAPTURED BEFORE ITS AWAIT (review of #3545, P2-1). The
 * reader's place across the prepend is the growth observer's row anchor; a `prevTop + delta` written
 * after the await undid whatever moved the pane meanwhile - a keyboard, the reader's own fling.
 */
describe('ChatArea older-history page', () => {
  it('leaves scrollTop as the pane holds it when the store answers', async () => {
    rowPx = 48; // 25 rows = 1200 px in a 700 px pane: scrollable, the window whole.
    modelGeometry();
    let answer: (more: boolean) => void = () => {};
    const load = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const { target } = mountSwitchable(25, load);
    await settleEntry();
    const scroller = target.querySelector<HTMLElement>('.chat-messages-scroll')!;
    scroller.scrollTop = 10;
    scroller.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(20);
    expect(load).toHaveBeenCalledTimes(1);
    // Mid-await the pane moves: the keyboard took the thread elsewhere.
    scroller.scrollTop = 400;
    answer(true);
    await settleEntry();
    expect(scroller.scrollTop).toBe(400);
  });
});
