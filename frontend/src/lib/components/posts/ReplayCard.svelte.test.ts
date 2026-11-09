// @vitest-environment happy-dom
/**
 * The replay card in the feed: says what it is, plays nothing, and a tap opens the viewer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReplayCard from './ReplayCard.svelte';
import type { PostEntity } from '$lib/posts/api';

vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy(
    {},
    { get: (_t, key) => (p?: unknown) => `${String(key)}${p ? JSON.stringify(p) : ''}` }
  ),
}));

const mounted: Record<string, unknown>[] = [];
function render(post: Partial<PostEntity>, onOpen = vi.fn()) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReplayCard, {
      target,
      props: { post: { id: 'p1', kind: 'replay', ...post } as PostEntity, onOpen },
    })
  );
  flushSync();
  return { target, onOpen };
}
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ReplayCard', () => {
  it('shows the mark and the length, and no time left', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { target } = render({ durationMs: 754_000, markdown: 'Soiree BDE' });
    expect(target.querySelector('[data-replay-card-badge]')?.textContent).toContain('replay_badge');
    expect(target.querySelector('[data-replay-card-duration]')?.textContent).toBe('12:34');
    expect(target.textContent).not.toContain('time_left');
    // The live title is the post caption, drawn by the post: the card adds no second one.
    expect(target.querySelector('[data-replay-card-title]')).toBeNull();
  });
  it('names the live when it had no title', () => {
    const { target } = render({ durationMs: 60_000, markdown: '' });
    expect(target.querySelector('[data-replay-card-title]')?.textContent).toContain(
      'replay_card_default_title'
    );
  });
  it('opens the viewer on a tap', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { target, onOpen } = render({ durationMs: 1000 });
    (target.querySelector('[data-replay-card]') as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
