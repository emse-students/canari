/**
 * F6 - THE FIRST FRAME OF AN ENTRY MOUNTS THE VIEWPORT TAIL, AND THE WIDEN DOES NOT MOVE THE READER.
 *
 * happy-dom lays nothing out, so the scroller's geometry is MODELLED: every mounted row is
 * `ROW_PX` tall and the pane is `PANE_PX` tall - a phone thread of one-line messages. What is
 * asserted is the component's own arithmetic over that model: how many rows the hidden entry
 * frame mounts, how many the widen adds, and where it leaves `scrollTop`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatArea from './ChatArea.svelte';
import type { ChatMessage, Conversation } from '$lib/types';

const PANE_PX = 700;
const ROW_SELECTOR = '[id^="msg-"]';

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

afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  restore.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});

describe('ChatArea entry window (F6)', () => {
  it('a thread of one-line rows settles on the 60-row entry window, never on more', async () => {
    // 20 one-line rows (720 px) do not exceed a 700 px pane by the 40 px fillViewportThenPin wants,
    // so it steps RENDER_GROUPS_STEP (140) from the 20-row tail: 160 rows in the hidden frame.
    rowPx = 36;
    modelGeometry();
    const target = mountArea(300);
    await vi.waitFor(() => expect(target.querySelectorAll(ROW_SELECTOR).length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(60), {
      timeout: 2000,
    });
  });

  it('mounts 20 rows first, widens to 60, and moves scrollTop by exactly the height added', async () => {
    rowPx = 48; // 20 rows = 960 px: the viewport is filled, no fill step.
    modelGeometry();
    const target = mountArea(300);
    const scroller = () =>
      target
        .querySelector<HTMLElement>(ROW_SELECTOR)
        ?.closest<HTMLElement>('[class*="overflow-y"]') ?? null;
    await vi.waitFor(() => expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(20));
    const el = scroller();
    expect(el).not.toBeNull();
    const heightBefore = el!.scrollHeight;
    await vi.waitFor(() => expect(target.querySelectorAll(ROW_SELECTOR).length).toBe(60));
    expect(el!.scrollHeight - heightBefore).toBe(40 * rowPx);
    // The rows under the eye are the same: the reader is still at the bottom of the taller list.
    await vi.waitFor(() => expect(el!.scrollTop).toBe(el!.scrollHeight));
  });
});
