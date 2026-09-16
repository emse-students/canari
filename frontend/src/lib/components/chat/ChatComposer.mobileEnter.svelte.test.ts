/**
 * ON A PHONE, ENTER IS THE SAME KEY AS SHIFT+ENTER ON A KEYBOARD - A NEWLINE, NEVER A SEND.
 *
 * There is no "hold Shift" gesture on a phone's on-screen keyboard, so a plain Enter used to be
 * the only key reachable and it sent the message - the one thing `MessageBubbleToolbar`'s Send
 * button already exists for, on a device where a stray tap on the return key is far more likely
 * than a deliberate send (user, 2026-09-16). Desktop keeps sending on a plain Enter; only the
 * viewport question changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  window.matchMedia = originalMatchMedia;
});

const originalMatchMedia = window.matchMedia;

/** Minimal `MediaQueryList` double - `isNarrowChatLayout()` reads only `.matches`. */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

interface Harness {
  messageText: string;
  onMessageChange: (v: string) => void;
  onSend: () => void;
  sendCount: number;
}

function mountComposer(): Harness {
  const props: Harness = $state({
    messageText: 'hello',
    onMessageChange: (v: string) => {
      props.messageText = v;
    },
    onSend: () => {
      props.sendCount++;
    },
    sendCount: 0,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatComposer, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
  return props;
}

function editor(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="textbox"]');
  if (!el) throw new Error('composer editor not found');
  return el;
}

/** Dispatches a plain (no Shift) Enter keydown on the editor and returns the event. */
function pressEnter(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  editor().dispatchEvent(event);
  flushSync();
  return event;
}

/** Dispatches a Shift+Enter keydown on the editor and returns the event. */
function pressShiftEnter(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  editor().dispatchEvent(event);
  flushSync();
  return event;
}

describe('ChatComposer - Enter sends on desktop, and is a newline on a phone or with Shift', () => {
  it('sends on a plain Enter when the viewport is not a phone', () => {
    stubMatchMedia(false);
    const props = mountComposer();

    const event = pressEnter();

    expect(props.sendCount).toBe(1);
    expect(event.defaultPrevented, 'a send must swallow the keystroke').toBe(true);
  });

  it('does not send on a plain Enter when the viewport is a phone - it inserts a real newline instead', () => {
    stubMatchMedia(true);
    const props = mountComposer();

    const event = pressEnter();

    expect(props.sendCount).toBe(0);
    expect(event.defaultPrevented, 'the explicit insertion must own this keystroke').toBe(true);
    // The insertion goes through `insertNewlineAtCursor` (never the browser's own default
    // handling of an unprevented Enter, which splits the editor into a new block that the
    // serializer reads back with the boundary silently dropped - measured 2026-09-16) - so a
    // real `\n` must be in the text, not merely "the message did not send".
    expect(props.messageText).toContain('\n');
  });

  it('does not send on Shift+Enter on desktop either - same newline path as the phone', () => {
    stubMatchMedia(false);
    const props = mountComposer();

    const event = pressShiftEnter();

    expect(props.sendCount).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(props.messageText).toContain('\n');
  });
});
