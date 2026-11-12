// @vitest-environment happy-dom
/**
 * The chat reel tile's watchable state draws the house glass play triangle (owner, 2026-11-11),
 * not a disc around a Lucide `Play`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatReelTile from './ChatReelTile.svelte';
import type { MediaRef } from '$lib/media';

vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy(
    {},
    { get: (_t, key) => (p?: unknown) => `${String(key)}${p ? JSON.stringify(p) : ''}` }
  ),
}));

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

describe('ChatReelTile play glyph', () => {
  it('draws the glass triangle and no Lucide play icon', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted.push(
      mount(ChatReelTile, {
        target,
        props: {
          mediaRef: { mediaId: 'm1', width: 720, height: 1280, durationMs: 12_000 } as MediaRef,
          tombstone: null,
          senderName: 'Alice',
          sentAt: new Date(),
          onOpen: vi.fn(),
        },
      })
    );
    flushSync();
    expect(target.querySelector('[data-reel-tile]')).not.toBeNull();
    expect(target.querySelector('[data-video-glass-glyph="play"]')).not.toBeNull();
    expect(target.querySelector('.lucide-play')).toBeNull();
  });
});
