// @vitest-environment happy-dom
/**
 * THE REPLAY PAGE: one player per active page, the time left on it and nowhere else, and a screen for
 * every way it can fail. The segments, the seal and the media source are stand-ins; the shared
 * player is a stub that hands over a `<video>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ReplayPane from './ReplayPane.svelte';
import { LiveRefusalError } from '$lib/live/api';
import type { PostEntity } from '$lib/posts/api';

vi.mock('$lib/components/shared/VideoPlayer.svelte', async () => ({
  default: (await import('./ReplayVideoStub.test-helper.svelte')).default,
}));
vi.mock('$lib/paraglide/messages', () => ({
  m: new Proxy(
    {},
    { get: (_t, key) => (p?: unknown) => `${String(key)}${p ? JSON.stringify(p) : ''}` }
  ),
}));

const post = { id: 'p1', liveId: 'live-1', kind: 'replay' } as PostEntity;
const mounted: Record<string, unknown>[] = [];

class FakeBuffer extends EventTarget {
  updating = false;
  mode = '';
  timestampOffset = 0;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  appendBuffer() {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    });
  }
  remove() {}
}
class FakeSource extends EventTarget {
  readyState = 'open';
  duration = 0;
  addSourceBuffer() {
    return new FakeBuffer();
  }
  endOfStream() {}
}

function page(over: Record<string, unknown> = {}) {
  return {
    liveId: 'live-1',
    postId: 'p1',
    key: 'k',
    durationMs: 60_000,
    expiresAt: '2026-11-12T10:00:00.000Z',
    serverNow: '2026-11-09T10:00:00.000Z',
    segments: [],
    nextFrom: null,
    ...over,
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function render(
  active: boolean,
  fetchReplay: () => Promise<unknown>,
  onReady = vi.fn(),
  mediaSource: () => unknown = () => ({
    name: 'MediaSource',
    create: () => new FakeSource(),
    isTypeSupported: () => true,
  }),
  extra: { post?: PostEntity; loadCover?: unknown } = {}
) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  URL.createObjectURL = vi.fn(() => 'blob:replay');
  URL.revokeObjectURL = vi.fn();
  const instance = mount(ReplayPane, {
    target,
    props: {
      post: extra.post ?? post,
      loadCover: extra.loadCover as never,
      active,
      playerSafeBottom: true,
      onReady,
      deps: { fetchReplay: fetchReplay as never, mediaSource: mediaSource as never },
    },
  });
  mounted.push(instance);
  return { target, onReady };
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ReplayPane', () => {
  it('mounts no player on a page that is not on screen, and still marks itself a replay', async () => {
    const fetchReplay = vi.fn(async () => page());
    const { target } = render(false, fetchReplay);
    await settle();
    expect(fetchReplay).not.toHaveBeenCalled();
    expect(target.querySelector('[data-video-player-stub]')).toBeNull();
    expect(target.querySelector('[data-replay-chip]')?.textContent).toContain('replay_badge');
  });

  it('plays the active page and draws the time left from the replay route own clocks', async () => {
    const { target } = render(true, async () => page());
    await settle();
    expect(target.querySelector('[data-video-player-stub="blob:replay"]')).not.toBeNull();
    expect(target.querySelector('[data-replay-time-left]')?.textContent).toContain(
      'replay_time_left_days{"count":3}'
    );
  });

  it('says the replay is gone on a 404, with no player', async () => {
    const { target, onReady } = render(true, async () => {
      throw new LiveRefusalError(404, 'LIVE_NOT_FOUND', 'x', 'not-found', null, null, null);
    });
    await settle();
    expect(target.querySelector('[data-replay-gone]')).not.toBeNull();
    expect(target.querySelector('[data-video-player-stub]')).toBeNull();
    // A decided failure settles the page: the viewer is not left waiting on it.
    expect(onReady).toHaveBeenCalled();
  });

  it('says an engine without MediaSource cannot play it, and offers a retry', async () => {
    const { target } = render(
      true,
      async () => page(),
      vi.fn(),
      () => null
    );
    await settle();
    expect(target.querySelector('[data-replay-unavailable="unsupported"]')).not.toBeNull();
    expect(target.querySelector('[data-replay-retry]')).not.toBeNull();
  });

  it('stands the live cover over the page until the picture plays, on a neighbour page too', async () => {
    const withCover = {
      ...post,
      poster: { name: 'poster-1', ageMs: 0 },
      posterKey: 'pk',
    } as PostEntity;
    const loadCover = vi.fn(async () => ({ kind: 'shown' as const, image: new Blob(['x']) }));
    const idle = render(
      false,
      vi.fn(async () => page()),
      vi.fn(),
      undefined,
      {
        post: withCover,
        loadCover,
      }
    );
    await settle();
    expect(idle.target.querySelector('[data-replay-cover]')).not.toBeNull();
    expect(loadCover).toHaveBeenCalledWith(
      { id: 'live-1', poster: { name: 'poster-1', ageMs: 0 }, posterKey: 'pk' },
      expect.anything()
    );
    // The active page while its replay is still being listed: the cover, under the spinner.
    const { target } = render(true, () => new Promise(() => {}), vi.fn(), undefined, {
      post: withCover,
      loadCover,
    });
    await settle();
    expect(target.querySelector('[data-replay-cover]')).not.toBeNull();
    target.querySelector('[data-replay-pane]')!.dispatchEvent(new Event('playing'));
    flushSync();
    expect(target.querySelector('[data-replay-cover]')).toBeNull();
  });

  it('draws no cover for a live that stored none', async () => {
    const { target } = render(
      false,
      vi.fn(async () => page())
    );
    await settle();
    expect(target.querySelector('[data-replay-cover]')).toBeNull();
  });
});
