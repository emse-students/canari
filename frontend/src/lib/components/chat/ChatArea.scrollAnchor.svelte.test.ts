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
import {
  noteKeyboardAtRest,
  noteKeyboardFrameAwaited,
  noteKeyboardFrameLanded,
  noteKeyboardTransition,
} from '$lib/stores/keyboardTransition';
import { Log } from '$lib/utils/Log';
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
  // The wheel itself: only a reader's input may lower the stick-to-bottom flag (2026-11-23).
  scroller.dispatchEvent(new Event('wheel'));
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

/** `count` messages whose newest is the reader's own. */
function ownNewestConversation(count: number): Conversation {
  const conversation = conversationOf(count);
  conversation.messages[count - 1] = { ...conversation.messages[count - 1], isOwn: true };
  return conversation;
}

/** The same conversation with `count` OLDER messages joined above it: a page of history. */
function withOlderPage(conversation: Conversation, count: number): Conversation {
  const first = conversation.messages[0].timestamp.getTime();
  const older: ChatMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `${conversation.id}old${String(i).padStart(4, '0')}`,
    senderId: 'alice',
    content: `older ${i}`,
    timestamp: new Date(first - (count - i) * 1000),
    isOwn: false,
  }));
  return { ...conversation, messages: [...older, ...conversation.messages] };
}

describe('ChatArea follows the bottom for a message the reader just sent, and for nothing else', () => {
  /** A reader who went up to read a thread whose newest message is their own. */
  async function readerAboveTheirOwnLastMessage() {
    const area = mountArea();
    area.props.conversation = ownNewestConversation(THREAD);
    flushSync();
    await settleEntry();
    await scrollTo(scrollerOf(area.target), 900);
    await scrollTo(scrollerOf(area.target), 410);
    return area;
  }

  const newestRowTop = (target: HTMLElement) => {
    const rows = rowsOf(target);
    return rows[rows.length - 1].getBoundingClientRect().top;
  };

  it('an older page joining under an own newest message leaves the reader where they read', async () => {
    const area = await readerAboveTheirOwnLastMessage();
    expect(newestRowTop(area.target)).toBeGreaterThan(PANE_PX);

    area.props.conversation = withOlderPage(area.props.conversation, 50);
    flushSync();
    await settleEntry();

    // The newest message is still below the pane: nothing took the reader to the bottom.
    expect(newestRowTop(area.target)).toBeGreaterThan(PANE_PX);
  });

  it('a message the reader sends while reading above still takes them to the bottom', async () => {
    const area = await readerAboveTheirOwnLastMessage();
    const sent = conversationOf(THREAD + 1);
    sent.messages[THREAD - 1] = { ...sent.messages[THREAD - 1], isOwn: true };
    // Composed here: drawn with its send state (`ownMessageAppended`).
    sent.messages[THREAD] = { ...sent.messages[THREAD], isOwn: true, status: 'pending' };

    area.props.conversation = sent;
    flushSync();
    await settleEntry();

    expect(newestRowTop(area.target)).toBeLessThan(PANE_PX);
  });

  /**
   * A catch-up ending with a message this account wrote on its OTHER device (no send state) is an
   * arrival, not a send (review of #4054): the reader reading above stays where they are.
   */
  it('a message of this account that ARRIVED from its other device leaves the reader above', async () => {
    const area = await readerAboveTheirOwnLastMessage();
    const arrived = conversationOf(THREAD + 1);
    arrived.messages[THREAD - 1] = { ...arrived.messages[THREAD - 1], isOwn: true };
    arrived.messages[THREAD] = { ...arrived.messages[THREAD], isOwn: true };

    area.props.conversation = arrived;
    flushSync();
    await settleEntry();

    expect(newestRowTop(area.target)).toBeGreaterThan(PANE_PX);
  });
});

/**
 * THE ENGINE'S KEYBOARD MOVE IS PUT BACK, AND ONLY IT (iPhone 12, 1.8.0-alpha.1, #3984; chat.md). The
 * pane at its end, then moved 375 px up with no reader input and its reach unchanged - with a keyboard
 * transition started (a field took focus) it is put back; with none (a screen reader's scroll,
 * find-in-page) the flag falls as it always did.
 */
describe('ChatArea and a move of the pane no reader made', () => {
  const ENGINE_MOVE = 375;
  const reach = () => THREAD * ROW_PX - PANE_PX;
  const arrowShown = (target: HTMLElement) =>
    target.querySelector('.chat-scroll-bottom-button') !== null;

  // Every test starts with no keyboard transition moving (the count is the document's).
  beforeEach(() => noteKeyboardAtRest('test start'));

  async function engineMove(scroller: HTMLElement) {
    scroller.scrollTop = reach() - ENGINE_MOVE;
    scroller.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(50);
    flushSync();
  }

  it('puts the engine keyboard move back at the end, logs it once and holds the flag', async () => {
    const info = vi.spyOn(Log, 'i');
    const area = mountArea();
    await settleEntry();
    const scroller = scrollerOf(area.target);
    noteKeyboardTransition('keyboard opened');
    await engineMove(scroller);

    expect(scroller.scrollTop).toBeGreaterThanOrEqual(reach());
    expect(arrowShown(area.target)).toBe(false);
    const lines = info.mock.calls.filter(([, line]) => String(line).includes('left the bottom'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][1])).toMatch(/put back at the end \(put-back 1 of this pane/);

    // The transition is spent: the same move again is not put back a second time.
    await engineMove(scroller);
    expect(scroller.scrollTop).toBe(reach() - ENGINE_MOVE);
    expect(arrowShown(area.target)).toBe(true);
  });

  it.each([
    ['no keyboard transition at all', false],
    ['a keyboard transition that came to rest', true],
  ])('lets an unexplained move after %s lower the flag (the assistive case)', async (_, opened) => {
    const info = vi.spyOn(Log, 'i');
    const area = mountArea();
    await settleEntry();
    const scroller = scrollerOf(area.target);
    if (opened) {
      noteKeyboardTransition('keyboard opened');
      noteKeyboardAtRest('the shell: at rest');
    }
    await engineMove(scroller);

    expect(scroller.scrollTop).toBe(reach() - ENGINE_MOVE);
    expect(arrowShown(area.target)).toBe(true);
    // INFO, so the exported log names it (the home-button return of 2026-11-23 had nothing to read).
    const lines = info.mock.calls.filter(([, line]) => String(line).includes('left the bottom'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][1])).toContain('the flag falls');
  });

  /**
   * THE HOME-BUTTON RETURN WITH THE KEYBOARD UP (iPhone 12, 1.8.0-alpha.4, 4 of 10): the transition the
   * shell's will-show started (`canariKeyboardShows`) is moving when WebKit's reveal moves the pane at
   * the return, so the move is put back; the geometry lines say where the pane stood at each edge.
   */
  it('puts back the reveal of a keyboard that came back with the app, and reports each edge', async () => {
    const info = vi.spyOn(Log, 'i');
    const area = mountArea();
    await settleEntry();
    const scroller = scrollerOf(area.target);
    noteKeyboardTransition('the shell: a keyboard will show');
    await vi.advanceTimersByTimeAsync(50);
    await engineMove(scroller);
    noteKeyboardAtRest('the shell: did show');
    await vi.advanceTimersByTimeAsync(50);

    expect(scroller.scrollTop).toBeGreaterThanOrEqual(reach());
    expect(arrowShown(area.target)).toBe(false);
    const geometry = info.mock.calls
      .filter(([tag]) => tag === 'CHAT_VIEW')
      .map(([, line]) => String(line))
      .filter((line) => line.includes('keyboard transition'));
    expect(geometry).toHaveLength(2);
    expect(geometry[0]).toMatch(/starts \(its frame\): .* isNearBottom=true .* moving$/);
    expect(geometry[1]).toMatch(
      /at rest \(its frame\): .* pinned=true isNearBottom=true .* at rest$/
    );
  });

  /**
   * THE RETURN WHOSE REST CAME FIRST (iPhone 12, `1.8.0-alpha.6`, 5 of 11): the keyboard comes back with
   * no animation, the shell's word of rest reaches the page before the WebView's frame, and the engine's
   * move lands after it. The rest is held until the frame lands, so the move is still the keyboard's.
   */
  it('puts back the move that lands after an early rest, while the frame is still awaited', async () => {
    const info = vi.spyOn(Log, 'i');
    vi.spyOn(Log, 'w').mockImplementation(() => {});
    const area = mountArea();
    await settleEntry();
    const scroller = scrollerOf(area.target);
    noteKeyboardTransition('the shell: a keyboard will show');
    noteKeyboardFrameAwaited('a hand-off of 301px');
    noteKeyboardAtRest('the shell: did show, ahead of its frame');
    await vi.advanceTimersByTimeAsync(50);
    await engineMove(scroller);
    noteKeyboardFrameLanded('keyboard target 301 spent');
    await vi.advanceTimersByTimeAsync(50);

    expect(scroller.scrollTop).toBeGreaterThanOrEqual(reach());
    expect(arrowShown(area.target)).toBe(false);
    const lines = info.mock.calls.filter(([, line]) => String(line).includes('left the bottom'));
    expect(lines).toHaveLength(1);
    expect(String(lines[0][1])).toContain("the engine's keyboard move, put back at the end");
  });

  it('reads a start and a rest heard in one task in their order, each with its own state', async () => {
    const info = vi.spyOn(Log, 'i');
    const area = mountArea();
    await settleEntry();
    noteKeyboardTransition('keyboard opened');
    noteKeyboardAtRest('the viewport reading is the keyboard where it stands');
    // Nothing is read inside the keyboard's own update: both wait for the frame.
    const geometryLines = () =>
      info.mock.calls
        .filter(([tag]) => tag === 'CHAT_VIEW')
        .map(([, line]) => String(line))
        .filter((line) => line.includes('keyboard transition'));
    expect(geometryLines()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);
    const lines = geometryLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/starts \(its frame\): .* moving$/);
    expect(lines[1]).toMatch(/at rest \(its frame\): .* at rest$/);
    expect(area.target).toBeTruthy();
  });
});
