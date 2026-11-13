// @vitest-environment happy-dom
/**
 * ONE TAP LIKES, A HOLD CHOOSES (owner, 2026-11-09): the reaction button of a post's action bar.
 * Pinned: a tap is `onQuickReact` and never opens the picker; a hold opens it and the click ending
 * the hold is swallowed; a press that travels is a scroll and opens nothing; the context menu,
 * ArrowUp and the assistive button reach the picker with no gesture; Escape closes it.
 */
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostActions from './PostActions.svelte';
import { LONG_PRESS_MS } from '$lib/actions/longPress';
import { REACTIONS, reactionTypeToLabel } from '$lib/posts/reactions';

const mounted: (() => void)[] = [];
let target: HTMLElement;
let quick: Mock<() => void>;
let open: Mock<() => void>;
let close: Mock<() => void>;

beforeEach(() => {
  vi.useFakeTimers();
  quick = vi.fn<() => void>();
  open = vi.fn<() => void>();
  close = vi.fn<() => void>();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountBar(userReaction: string | null = null, showReactionPicker = false) {
  target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(PostActions, {
    target,
    props: {
      userReaction,
      showReactionPicker,
      reactionList: REACTIONS,
      onReactionSelect: vi.fn(),
      onQuickReact: quick,
      onOpenReactionPicker: open,
      onCloseReactionPicker: close,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target.querySelector<HTMLButtonElement>('button[data-post-react]')!;
}

function pointer(type: string, init: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerType: 'touch',
    button: 0,
    clientX: 0,
    clientY: 0,
    ...init,
  });
}

it('a tap is one quick reaction and never opens the picker', () => {
  const button = mountBar();
  button.dispatchEvent(pointer('pointerdown'));
  vi.advanceTimersByTime(100);
  button.dispatchEvent(pointer('pointerup'));
  button.click();
  expect(quick).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
});

it('a hold opens the picker and the click ending it does not like', () => {
  const button = mountBar();
  button.dispatchEvent(pointer('pointerdown'));
  vi.advanceTimersByTime(LONG_PRESS_MS + 1);
  expect(open).toHaveBeenCalledTimes(1);
  button.dispatchEvent(pointer('pointerup'));
  button.click();
  expect(quick).not.toHaveBeenCalled();
});

it('a hold while reacted opens the picker too, to change the reaction', () => {
  const button = mountBar("J'aime");
  button.dispatchEvent(pointer('pointerdown'));
  vi.advanceTimersByTime(LONG_PRESS_MS + 1);
  expect(open).toHaveBeenCalledTimes(1);
  expect(button.getAttribute('aria-label')).toBe(reactionTypeToLabel("J'aime"));
});

it('a press that travels is a scroll: no picker, no like', () => {
  const button = mountBar();
  button.dispatchEvent(pointer('pointerdown', { clientY: 100 }));
  vi.advanceTimersByTime(100);
  button.dispatchEvent(pointer('pointermove', { clientY: 140 }));
  vi.advanceTimersByTime(LONG_PRESS_MS * 2);
  button.dispatchEvent(pointer('pointercancel'));
  expect(open).not.toHaveBeenCalled();
  expect(quick).not.toHaveBeenCalled();
});

it('reaches the picker without a gesture: context menu, ArrowUp, the assistive button', () => {
  const button = mountBar();
  button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  target.querySelector<HTMLButtonElement>('button[data-post-react-picker-open]')!.click();
  expect(open).toHaveBeenCalledTimes(3);
  expect(quick).not.toHaveBeenCalled();
  // The popup is a plain group, which no aria-haspopup value names: only aria-expanded says it.
  expect(button.hasAttribute('aria-haspopup')).toBe(false);
});

it('Escape closes the open picker', () => {
  mountBar(null, true);
  target
    .querySelector('[role="group"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(close).toHaveBeenCalledTimes(1);
});

it('announces the reacted state and shows the assistive button on keyboard focus', () => {
  expect(mountBar(null).getAttribute('aria-pressed')).toBe('false');
  document.body.innerHTML = '';
  expect(mountBar('LIKE').getAttribute('aria-pressed')).toBe('true');
  const assistive = target.querySelector<HTMLButtonElement>('button[data-post-react-picker-open]')!;
  expect(assistive.className).toContain('focus:not-sr-only');
});
