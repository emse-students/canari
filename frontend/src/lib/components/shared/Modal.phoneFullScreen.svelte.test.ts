/**
 * `phoneFullScreen` HANDS THE CHILD AN UNPADDED, UNSCROLLED BODY, AND MARKS THE OVERLAY.
 *
 * The composer lays itself out as a scroll region plus a footer that must sit on the keyboard. That
 * only works if the Modal's body neither pads nor scrolls - a scrolling body would carry the footer
 * away with the text - and if the overlay carries the class `app.css` keys the edge-to-edge rules
 * on. Both are pinned here, against the default, so a later "tidy" of the body classes that folds
 * the two branches back into one is caught.
 */
import { it, expect, afterEach } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import Modal from './Modal.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const children = createRawSnippet(() => ({ render: () => '<p data-testid="child">x</p>' }));

function mountModal(phoneFullScreen: boolean) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(Modal, {
    target,
    props: { open: true, title: 'T', phoneFullScreen, onClose: () => {}, children },
  });
  mounted.push(() => unmount(component));
  flushSync();
  const overlay = document.querySelector<HTMLElement>('[data-keyboard-aware-overlay]')!;
  const body = document.querySelector('[data-testid="child"]')!.parentElement!;
  return { overlay, body };
}

it('marks the overlay and leaves the body to the child when set', () => {
  const { overlay, body } = mountModal(true);
  expect(overlay.classList.contains('modal-phone-full')).toBe(true);
  expect(body.classList.contains('px-6')).toBe(false);
  expect(body.classList.contains('overflow-y-auto')).toBe(false);
  expect(body.classList.contains('min-h-0')).toBe(true);
});

it('keeps the padded, scrolling body by default', () => {
  const { overlay, body } = mountModal(false);
  expect(overlay.classList.contains('modal-phone-full')).toBe(false);
  expect(body.classList.contains('px-6')).toBe(true);
  expect(body.classList.contains('overflow-y-auto')).toBe(true);
});
