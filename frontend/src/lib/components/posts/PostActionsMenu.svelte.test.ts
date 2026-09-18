/**
 * THE MENU IS PORTALLED, SO A HOVERED CARD CANNOT TRAP IT UNDER THE NEXT POST.
 *
 * `PostCard` lifts on hover (`hover:-translate-y-0.5`), which creates a stacking context for
 * exactly the card the menu was opened on - the one under the cursor. `z-(--z-popover)` then only
 * won against siblings INSIDE that context; from outside, the card's own box is still
 * `z-index: auto`, so the next post in the feed - later in DOM order, same layer - painted over
 * the whole thing, popover included. Escaping to `<body>` (the same mechanism `UserAutocomplete`
 * already uses) is what removes the trap, and this is the property to pin: not a pixel position,
 * which `fixedPopover.test.ts` already owns, but that the menu genuinely leaves the card's subtree.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostActionsMenu from './PostActionsMenu.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountMenu(props: Partial<Parameters<typeof PostActionsMenu>[1]> = {}) {
  // A stand-in for the card, so "left its subtree" has a subtree to leave.
  const card = document.createElement('div');
  document.body.appendChild(card);

  // happy-dom's `Animation.cancel()` rejects the animation it is asked to cancel, which Svelte's
  // own transition teardown does not expect and neither test here is about: the menu's
  // `transition:slide` is incidental to the stacking-context fix, not its subject. Stubbed rather
  // than left real, so tearing down an open (or just-closed) menu never throws an unhandled
  // rejection after the test itself has already passed.
  vi.spyOn(HTMLElement.prototype, 'animate').mockReturnValue({
    cancel: () => {},
    play: () => {},
    pause: () => {},
    finish: () => {},
    effect: null,
    finished: Promise.resolve(),
    onfinish: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Animation);

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 40,
    bottom: 76,
    left: 300,
    right: 336,
    width: 36,
    height: 36,
  } as DOMRect);

  const instance = mount(PostActionsMenu, {
    target: card,
    props: {
      pinned: false,
      canManage: false,
      canPin: false,
      canReport: true,
      canUnmaskAnonymous: false,
      isLoggedIn: true,
      onTogglePin: () => {},
      onStartEdit: () => {},
      onDelete: () => {},
      onReport: () => {},
      onUnmaskAnonymous: () => {},
      postId: 'p1',
      ...props,
    },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return card;
}

it('renders the menu outside the card once opened, not nested inside it', () => {
  const card = mountMenu();
  const button = card.querySelector('button')!;

  button.click();
  flushSync();

  const menu = document.body.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  // The whole point: NOT a descendant of the card, so no ancestor of it can trap its z-index.
  expect(card.contains(menu)).toBe(false);
  expect(menu!.parentElement).toBe(document.body);
});

it('still treats a click inside the portalled menu as inside, not an outside click', () => {
  const onReport = vi.fn();
  const card = mountMenu({ onReport });
  const button = card.querySelector('button')!;

  button.click();
  flushSync();

  const reportItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find((el) =>
    el.textContent?.includes('Signaler')
  ) as HTMLElement | undefined;
  expect(reportItem).toBeDefined();

  reportItem!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  flushSync();

  // The definitive signal: `clickOutside`'s own callback never calls `onReport`, only `pick()`
  // does. If the portal had broken containment, this click would read as outside and `onReport`
  // would never fire - whether or not the menu's `slide` transition has finished playing out.
  expect(onReport).toHaveBeenCalledTimes(1);
});
