// @vitest-environment happy-dom
/**
 * A CONVERSATION OPENS WHERE THE READER LEFT IT (backlog: scroll kept when returning from a profile).
 *
 * happy-dom lays nothing out, so the geometry is MODELLED: every mounted row is `ROW_PX` tall, the
 * pane is `PANE_PX` tall and a row's top is its place in the mounted list minus the pane's
 * `scrollTop`. The position is written at `beforeNavigate` (captured below) and read by the next
 * mount of the same conversation, which is what the route does after a profile.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatArea from './ChatArea.svelte';
import { clearConversationAnchors } from '$lib/utils/chat/scrollAnchors';
import type { ChatMessage, Conversation } from '$lib/types';

type Nav = {
  willUnload?: boolean;
  from?: { url: URL };
  to?: { url: URL } | null;
};
const leaving: ((nav: Nav) => void)[] = [];
const landed: (() => void)[] = [];
vi.mock('$app/navigation', () => ({
  goto: async () => {},
  invalidateAll: async () => {},
  afterNavigate: (callback: () => void) => {
    landed.push(callback);
    return () => {};
  },
  disableScrollHandling: () => {},
  pushState: () => {},
  replaceState: () => {},
  preloadCode: async () => {},
  beforeNavigate: (callback: (nav: Nav) => void) => {
    leaving.push(callback);
    return () => {};
  },
}));
vi.mock('$lib/utils/users/displayName', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/users/displayName')>()),
  resolveUserDisplayName: async (id: string) => id,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

const PANE_PX = 700;
const ROW_PX = 40;
const THREAD = 61;
const ROW_SELECTOR = '[id^="msg-"]';

const mounted: (() => void)[] = [];
const restore: (() => void)[] = [];

function modelGeometry() {
  const proto = HTMLElement.prototype;
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return Math.max(this.querySelectorAll(ROW_SELECTOR).length * ROW_PX, PANE_PX);
    },
  });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => PANE_PX });
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (!this.matches(ROW_SELECTOR)) return rect!.value.call(this);
      const scroller = this.closest<HTMLElement>('[class*="overflow-y"]');
      const rows = [...(scroller?.querySelectorAll(ROW_SELECTOR) ?? [])];
      const top = rows.indexOf(this) * ROW_PX - (scroller?.scrollTop ?? 0);
      return {
        top,
        bottom: top + ROW_PX,
        left: 0,
        right: 0,
        width: 0,
        height: ROW_PX,
        x: 0,
        y: top,
      };
    },
  });
  restore.push(() => {
    delete (proto as unknown as Record<string, unknown>).scrollHeight;
    delete (proto as unknown as Record<string, unknown>).clientHeight;
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

function mountArea(id = 'g1', count = THREAD) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({
    conversation: conversationOf(count, id),
    messageText: '',
    onMessageChange: () => {},
    bindDraftWriter: () => () => {},
    onSend: () => {},
    onInviteMembers: () => {},
  });
  const app = mount(ChatArea, { target, props });
  flushSync();
  let gone = false;
  const close = () => {
    if (gone) return;
    gone = true;
    void unmount(app);
    target.remove();
  };
  mounted.push(close);
  return { target, close, props };
}

async function settleEntry() {
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(100);
}

const scrollerOf = (target: HTMLElement) =>
  target.querySelector<HTMLElement>('.chat-messages-scroll')!;

const rowsOf = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>(ROW_SELECTOR)];

/** A reader's wheel: moves the pane and lets the component measure it (it leaves the bottom). */
async function scrollTo(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(50);
}

const nav = (from: string, to: string): Nav => ({
  willUnload: false,
  from: { url: new URL(from, 'http://canari.test') },
  to: { url: new URL(to, 'http://canari.test') },
});

/** The route's teardown: every `beforeNavigate` callback of the live pane runs, then it unmounts. */
function navigateAway(area: { close: () => void }, to = '/profile/u1') {
  for (const callback of leaving) callback(nav('/chat', to));
  area.close();
  leaving.length = 0;
  landed.length = 0;
}

async function scrolledUpReader(id = 'g1') {
  const area = mountArea(id);
  await settleEntry();
  await scrollTo(scrollerOf(area.target), 900);
  await scrollTo(scrollerOf(area.target), 410);
  return area;
}

async function expectBottomEntry(id = 'g1', count = THREAD) {
  const area = mountArea(id, count);
  await settleEntry();
  const rows = rowsOf(area.target);
  expect(rows[rows.length - 1].getBoundingClientRect().top).toBeLessThan(PANE_PX);
}

beforeEach(() => {
  leaving.length = 0;
  landed.length = 0;
  clearConversationAnchors();
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'],
  });
  modelGeometry();
});

afterEach(() => {
  vi.useRealTimers();
  mounted.splice(0).forEach((f) => f());
  restore.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});

describe('ChatArea keeps the place of a reader across a profile', () => {
  it('a reader half-way up comes back to the same message, at the same offset', async () => {
    const first = mountArea();
    await settleEntry();
    const scroller = scrollerOf(first.target);
    // Pinned to the bottom after the entry; the wheel takes the reader up.
    await scrollTo(scroller, 900);
    await scrollTo(scroller, 410);
    const anchorRow = rowsOf(first.target).find((row) => row.getBoundingClientRect().bottom > 0)!;
    const anchorId = anchorRow.id;
    const offset = anchorRow.getBoundingClientRect().top;

    navigateAway(first);

    const second = mountArea();
    await settleEntry();
    const back = rowsOf(second.target).find((row) => row.id === anchorId);
    expect(back).toBeDefined();
    expect(back!.getBoundingClientRect().top).toBe(offset);
    expect(scrollerOf(second.target).classList.contains('opacity-100')).toBe(true);
    // Not at the bottom: the usual entry would have put the last row in view.
    const rows = rowsOf(second.target);
    expect(rows[rows.length - 1].getBoundingClientRect().top).toBeGreaterThan(PANE_PX);
  });

  it('a reader who left at the bottom reopens at the bottom, as before', async () => {
    const first = mountArea();
    await settleEntry();
    navigateAway(first);

    const second = mountArea();
    await settleEntry();
    const rows = rowsOf(second.target);
    expect(rows[rows.length - 1].getBoundingClientRect().top).toBeLessThan(PANE_PX);
  });

  it('a position is spent by the entry that reads it', async () => {
    const first = mountArea();
    await settleEntry();
    const scroller = scrollerOf(first.target);
    await scrollTo(scroller, 900);
    await scrollTo(scroller, 410);
    navigateAway(first);

    const second = mountArea();
    await settleEntry();
    // The second visit ends without a navigation (nothing is written): the first position was spent
    // by the second entry, so the third opens at the bottom, not back at it.
    second.close();
    const third = mountArea();
    await settleEntry();
    const rows = rowsOf(third.target);
    expect(rows[rows.length - 1].getBoundingClientRect().top).toBeLessThan(PANE_PX);
  });

  it('a navigation that is cancelled, or leaves the pane mounted, keeps nothing', async () => {
    const first = await scrolledUpReader();
    for (const callback of leaving) callback(nav('/chat', '/profile/u1'));
    // The overlay/cancelled case: the navigation ends with the pane still mounted.
    for (const callback of landed) callback();
    first.close();
    leaving.length = 0;
    landed.length = 0;
    await expectBottomEntry();
  });

  it('a navigation that stays on the same path, or unloads the page, keeps nothing', async () => {
    const first = await scrolledUpReader();
    for (const callback of leaving) callback(nav('/chat', '/chat?c=g1'));
    for (const callback of leaving) callback({ ...nav('/chat', '/profile/u1'), willUnload: true });
    first.close();
    leaving.length = 0;
    await expectBottomEntry();
  });

  it('only the immediate return is served: another conversation entered in between ends it', async () => {
    const first = await scrolledUpReader('g1');
    navigateAway(first);
    const other = mountArea('g2');
    await settleEntry();
    other.close();
    await expectBottomEntry('g1');
  });

  it('a conversation with newer messages than when the reader left opens at the usual entry', async () => {
    const first = await scrolledUpReader();
    navigateAway(first);
    await expectBottomEntry('g1', THREAD + 1);
  });

  it('a message arriving while the restore is in flight keeps the row', async () => {
    const first = await scrolledUpReader();
    const anchorRow = rowsOf(first.target).find((row) => row.getBoundingClientRect().bottom > 0)!;
    const anchorId = anchorRow.id;
    const offset = anchorRow.getBoundingClientRect().top;
    navigateAway(first);

    const second = mountArea();
    // The window has opened and the row is placed; the reveal frame has not run yet.
    await vi.advanceTimersByTimeAsync(0);
    second.props.conversation = conversationOf(THREAD + 1);
    flushSync();
    await settleEntry();
    const back = rowsOf(second.target).find((row) => row.id === anchorId);
    expect(back).toBeDefined();
    expect(back!.getBoundingClientRect().top).toBe(offset);
    expect(scrollerOf(second.target).classList.contains('opacity-100')).toBe(true);
  });
});
