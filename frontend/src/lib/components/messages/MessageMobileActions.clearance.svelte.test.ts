/**
 * THE SHEET USED TO COVER THE MESSAGE IT ACTS ON, AND THE ARITHMETIC ALONE DOES NOT PROVE IT DOESN'T.
 *
 * `sheetClearance` is tested on its own numbers next door. What is pinned here is the wiring: that
 * the sheet finds the scroller from the bubble it was given, that it measures its own resting top
 * from LAYOUT rather than from a rect a 220 ms fly transition is still moving, that it borrows the
 * room before scrolling into it, and that closing gives the room back.
 *
 * Geometry in happy-dom is all zeroes, so every box is stubbed - which is the point, since the rule
 * is a comparison between numbers no engine here can produce. The numbers used are the ones A1
 * reported on 2026-09-14: a bubble at 731-767 under a sheet whose strip starts at 749.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import MessageMobileActions from './MessageMobileActions.svelte';

const mounted: (() => void)[] = [];
let releaseAnimations: (() => void) | null = null;

// Closing the sheet plays an OUTRO on two elements, and tearing down cancels whatever is still in
// flight - which happy-dom reports as an unhandled rejection Svelte never created. See the helper.
beforeEach(() => {
  releaseAnimations = adoptTransitionAnimations();
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  releaseAnimations?.();
  releaseAnimations = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const SCREEN_BOTTOM = 945;
const SHEET_HEIGHT = 180;
const SHEET_BOTTOM_INSET = 16;
/** 945 - 16 - 180: exactly the 749 the phone reported. */
const SHEET_TOP = SCREEN_BOTTOM - SHEET_BOTTOM_INSET - SHEET_HEIGHT;

/**
 * Builds a thread whose bubble sits in the band the sheet covers, and mounts the sheet on it.
 *
 * `scrollRemaining` is the room the scroller already has below its current position. Zero is the
 * ordinary case - the message someone long-presses at the bottom of the screen is usually the last
 * one, so the thread is already at its maximum.
 */
function open({
  bubbleTop = 731,
  bubbleBottom = 767,
  scrollRemaining = 0,
  paddingBottom = '12px',
}: {
  bubbleTop?: number;
  bubbleBottom?: number;
  scrollRemaining?: number;
  paddingBottom?: string;
} = {}) {
  const scroller = document.createElement('div');
  scroller.className = 'chat-messages-scroll';
  const bubble = document.createElement('div');
  scroller.appendChild(bubble);
  document.body.appendChild(scroller);

  Object.defineProperty(scroller, 'clientHeight', { value: 680, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', {
    value: 680 + scrollRemaining,
    configurable: true,
  });

  const box = (top: number, bottom: number) =>
    ({ top, bottom, left: 0, right: 393, width: 393, height: bottom - top }) as DOMRect;

  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === scroller) return box(120, 800);
    if (this === bubble) return box(bubbleTop, bubbleBottom);
    // The portalled overlay: `fixed inset-0`, and the sheet's containing block.
    if (this.classList.contains('fixed')) return box(0, SCREEN_BOTTOM);
    return box(0, 0);
  });

  // `offsetHeight` is not implemented in happy-dom, and the resting top is computed from it.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) {
      return this.hasAttribute('data-keyboard-aware-actions') ? SHEET_HEIGHT : 0;
    },
    configurable: true,
  });

  const realComputed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
    if (el instanceof HTMLElement && el.hasAttribute('data-keyboard-aware-actions')) {
      return { ...realComputed(el), bottom: `${SHEET_BOTTOM_INSET}px` } as CSSStyleDeclaration;
    }
    if (el === scroller) return { ...realComputed(el), paddingBottom } as CSSStyleDeclaration;
    return realComputed(el);
  }) as typeof window.getComputedStyle);

  const props = $state({ visible: true, anchor: bubble as HTMLElement | null });
  const component = mount(MessageMobileActions, { target: document.body, props });
  mounted.push(() => unmount(component, { outro: false }));
  flushSync();

  return { scroller, props };
}

describe('MessageMobileActions and the message it must not cover', () => {
  it('lifts the thread by what the sheet covers, borrowing the room it does not have', () => {
    const { scroller } = open();

    // 767 + 8 - 749 = 26, and the thread had nowhere to go, so all 26 were borrowed on top of the
    // scroller's own 12 px of bottom padding.
    expect(scroller.scrollTop).toBe(26);
    expect(scroller.style.paddingBottom).toBe('38px');
  });

  it('gives the room back when the sheet closes, which is what puts the thread back', () => {
    const { scroller, props } = open();
    expect(scroller.style.paddingBottom).toBe('38px');

    props.visible = false;
    flushSync();

    expect(scroller.style.paddingBottom).toBe('');
  });

  it('borrows nothing when the thread can already scroll far enough', () => {
    const { scroller } = open({ scrollRemaining: 4000 });

    expect(scroller.scrollTop).toBe(26);
    expect(scroller.style.paddingBottom).toBe('');
  });

  it('leaves a message the sheet already clears exactly where it is', () => {
    // Mid-thread, a long way above the sheet.
    const { scroller } = open({ bubbleTop: 300, bubbleBottom: 336, scrollRemaining: 4000 });

    expect(scroller.scrollTop).toBe(0);
    expect(scroller.style.paddingBottom).toBe('');
  });

  it('measures the sheet from layout, so the fly transition cannot change the lift', () => {
    // The stubbed rect for the sheet is all zeros - the shape a transform mid-flight would give.
    // If the component read it, the lift would be computed against a top of 0 and come out as 0.
    const { scroller } = open();

    expect(scroller.scrollTop).toBe(767 + 8 - SHEET_TOP);
  });

  it('does nothing without a bubble to keep clear', () => {
    const scroller = document.createElement('div');
    scroller.className = 'chat-messages-scroll';
    document.body.appendChild(scroller);

    const component = mount(MessageMobileActions, {
      target: document.body,
      props: { visible: true },
    });
    mounted.push(() => unmount(component, { outro: false }));
    flushSync();

    expect(scroller.scrollTop).toBe(0);
    expect(scroller.style.paddingBottom).toBe('');
  });
});
