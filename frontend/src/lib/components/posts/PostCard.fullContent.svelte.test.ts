// @vitest-environment happy-dom
/**
 * THE POST'S OWN PAGE SHOWS THE WHOLE TEXT (owner inventory, 2026-11-26): `PostCard` passes
 * `fullContent` to `PostContent`, which then draws no "Voir plus". A feed card keeps the fold.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';

vi.mock('./PostContent.svelte', async () => ({
  default: (await import('./PostContentProbe.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];
beforeEach(() => {
  // The card's avatar and refresh reads have no server here: they never answer.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function render(extra: Record<string, unknown>) {
  const target = document.body.appendChild(document.createElement('div'));
  const post = {
    id: 'p1',
    kind: 'post',
    markdown: 'x',
    authorId: 'u2',
    createdAt: new Date(0).toISOString(),
    publishedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as never;
  const app = mount(PostCard, { target, props: { post, currentUserId: 'u1', ...extra } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

it('hands fullContent to the content when the page asks for it', () => {
  const target = render({ fullContent: true });
  expect(target.querySelector('[data-content-probe]')!.getAttribute('data-full')).toBe('true');
});

it('a feed card keeps the fold', () => {
  const target = render({});
  expect(target.querySelector('[data-content-probe]')!.getAttribute('data-full')).toBe('false');
});
