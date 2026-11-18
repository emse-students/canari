// @vitest-environment happy-dom
/**
 * A SINGLE TAP HIDES OR SHOWS THE VIEWER'S OVERLAY (owner, 2026-11-18): the top tabs and the close
 * button go with the slide's caption, author row and rail, only the player's line stays; the hidden
 * controls are neither focusable nor announced; the next tap, or the sr-only "show the controls"
 * button, brings them back; a new page shows them again.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReelViewer from './ReelViewer.svelte';
import type { PostEntity } from '$lib/posts/api';
import { WHEEL_QUIET_MS } from '$lib/reels/reelWheel';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/reels/reelPreload', () => ({
  ReelPreload: class {
    stop() {}
  },
}));
vi.mock('$lib/components/posts/PostMedia.svelte', async () => ({
  default: (await import('./PostMediaStub.test-helper.svelte')).default,
}));
vi.mock('$lib/utils/historyOverlayStack', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/historyOverlayStack')>()),
  pushHistoryOverlay: vi.fn(),
  releaseHistoryOverlay: vi.fn(),
  closeHistoryOverlayFromUi: vi.fn((close: () => void) => close()),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

function reel(id: string): PostEntity {
  return {
    id,
    kind: 'reel',
    markdown: 'caption',
    mentions: [],
    links: [],
    media: [
      { type: 'video', mediaId: `m-${id}`, key: 'k', iv: 'i', mimeType: 'video/mp4', size: 1 },
    ],
    images: [],
    polls: [],
    reactions: {},
    comments: [],
    createdAt: '2026-10-01T00:00:00Z',
    publishedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const mounted: Record<string, unknown>[] = [];

beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelViewer, {
      target,
      props: {
        startPost: reel('a'),
        authToken: 'tok',
        onClose: vi.fn(),
        loadPage: async () => [reel('b')],
      },
    })
  );
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const activeSlide = () => q('[data-reel-slide][data-reel-overlay]')!;
const scrim = () => q('[data-reel-top-scrim]')!;
const showButton = () => q<HTMLButtonElement>('[data-reel-overlay-show]');

async function tapPicture() {
  activeSlide().dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: 50,
      clientY: 50,
    })
  );
  await settle();
}

it('shown at first: the top bar is reachable and there is no assistive button', async () => {
  await render();
  expect(activeSlide().getAttribute('data-reel-overlay')).toBe('shown');
  expect(scrim().hasAttribute('inert')).toBe(false);
  expect(showButton()).toBeNull();
});

it('a tap hides the top tabs and the close button with the slide overlay; the next tap brings them back', async () => {
  await render();
  await tapPicture();
  expect(activeSlide().getAttribute('data-reel-overlay')).toBe('hidden');
  expect(scrim().hasAttribute('inert'), 'the close button and tabs are not focusable').toBe(true);
  expect(scrim().className).toContain('invisible');
  expect(q('[data-reel-caption]')!.hasAttribute('inert')).toBe(true);

  await tapPicture();
  expect(activeSlide().getAttribute('data-reel-overlay')).toBe('shown');
  expect(scrim().hasAttribute('inert')).toBe(false);
  expect(scrim().className).not.toContain('invisible');
});

it('hidden, a reader who cannot tap has a named button that brings the controls back and lands on the close button', async () => {
  await render();
  await tapPicture();
  const button = showButton()!;
  expect(button.textContent?.trim()).toBe(m.reels_overlay_show());
  button.click();
  await settle();
  expect(activeSlide().getAttribute('data-reel-overlay')).toBe('shown');
  expect(showButton()).toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe(m.reels_viewer_close());
});

it('a tap on the close button or a control is not a tap of the picture', async () => {
  await render();
  q<HTMLButtonElement>(`[aria-label="${m.reels_viewer_close()}"]`)!.dispatchEvent(
    new MouseEvent('click', { bubbles: true, detail: 1 })
  );
  await settle();
  expect(activeSlide().getAttribute('data-reel-overlay')).toBe('shown');
});

it('moving to the next reel shows the overlay again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await render();
  await tapPicture();
  expect(activeSlide().getAttribute('data-reel-overlay')).toBe('hidden');
  q('[data-post-media-stub]')!.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 })
  );
  await settle();
  vi.advanceTimersByTime(WHEEL_QUIET_MS + 1);
  await settle();
  expect(q('[data-post-media-stub]')!.getAttribute('data-post-media-stub')).toBe('m-b');
  expect(activeSlide().getAttribute('data-reel-overlay')).toBe('shown');
  expect(scrim().hasAttribute('inert')).toBe(false);
});

it('the way back is the FIRST element of the viewer, before the track and its focusable controls', async () => {
  await render();
  await tapPicture();
  const button = showButton()!;
  const frame = q('[data-reel-card]')!;
  expect(button.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('a tap that hides the overlay while focus is on one of its controls hands the focus to the way back', async () => {
  await render();
  const close = q<HTMLButtonElement>(`[aria-label="${m.reels_viewer_close()}"]`)!;
  close.focus();
  expect(document.activeElement).toBe(close);
  await tapPicture();
  await settle();
  expect(document.activeElement).toBe(showButton());
});
