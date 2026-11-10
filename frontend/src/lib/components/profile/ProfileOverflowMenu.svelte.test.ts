// @vitest-environment happy-dom
/**
 * THE "..." OF SOMEONE ELSE'S PROFILE holds report and block, and nothing else: they left the line
 * of their own where they floated alone at the right of the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import ProfileOverflowMenu from './ProfileOverflowMenu.svelte';
import { m } from '$lib/paraglide/messages';

// Never undone: a Svelte outro creates its main animation from a happy-dom timer that fires after
// the last test, so an `afterAll` undo would leave that animation unadopted and its cancellation
// an unhandled rejection.
adoptTransitionAnimations();

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render(blocked = false, busy = false) {
  const onReport = vi.fn();
  const onBlockToggle = vi.fn();
  component = mount(ProfileOverflowMenu, {
    target: document.body,
    props: { blocked, busy, onReport, onBlockToggle },
  });
  await settle();
  return { onReport, onBlockToggle };
}

const trigger = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="profile-overflow"]')!;
const items = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-menu-item]'));
async function open() {
  trigger().click();
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ProfileOverflowMenu', () => {
  it('is one named button that opens a menu holding report and block', async () => {
    await render();
    expect(trigger().getAttribute('aria-label')).toBe(m.profile_more_actions());
    expect(items()).toHaveLength(0);
    await open();
    expect(items().map((i) => i.dataset.menuItem)).toEqual(['report', 'block']);
    expect(items()[0].textContent).toContain(m.profile_report_btn());
    expect(items()[1].textContent).toContain(m.profile_block_btn());
  });

  it('keeps block destructive inside the menu', async () => {
    await render();
    await open();
    const label = items()[1].querySelector('[data-menu-item-label]')!;
    expect(label.className).toContain('text-red-err');
    expect(items()[0].querySelector('[data-menu-item-label]')!.className).not.toContain('red');
  });

  it('reads "unblock", neutral, once the person is blocked', async () => {
    await render(true);
    await open();
    expect(items()[1].textContent).toContain(m.profile_unblock_btn());
    expect(items()[1].querySelector('[data-menu-item-label]')!.className).not.toContain('red');
  });

  it('calls report, or the block toggle, and closes', async () => {
    const { onReport, onBlockToggle } = await render();
    await open();
    items()[0].click();
    await settle();
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await open();
    items()[1].click();
    await settle();
    expect(onBlockToggle).toHaveBeenCalledTimes(1);
  });

  it('does not start a second block change while one is in flight, but still reports', async () => {
    const { onReport, onBlockToggle } = await render(false, true);
    await open();
    items()[1].click();
    await settle();
    expect(onBlockToggle).not.toHaveBeenCalled();
    await open();
    items()[0].click();
    await settle();
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and hands focus back to its button', async () => {
    await render();
    await open();
    expect(items()).toHaveLength(2);
    items()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('offers the same two entries as a sheet on a phone', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    await render();
    await open();
    expect(items().map((i) => i.dataset.menuItem)).toEqual(['report', 'block']);
  });
});
