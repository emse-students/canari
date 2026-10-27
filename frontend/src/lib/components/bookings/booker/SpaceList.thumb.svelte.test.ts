// @vitest-environment happy-dom
/**
 * THE POSTER AS A THUMBNAIL IN THE LIST (D45, WP-R3). Pinned: a space with a poster shows it as a
 * thumbnail and one without keeps a glyph in the same box; and a thumbnail is decrypted ONLY once it
 * is near the viewport - a list of twenty spaces must not decrypt twenty posters on arrival.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { ListedSpace } from '$lib/bookings/api';

const download = vi.hoisted(() => vi.fn());
vi.mock('$lib/media', () => ({
  MediaService: class {
    downloadAndDecrypt = download;
  },
}));
vi.mock('$lib/utils/mediaBlobCache', () => ({ releaseDecryptedMediaBlobUrl: vi.fn() }));

import SpaceList from './SpaceList.svelte';

/** Keeps each observer so a test can scroll one list row into range on its own. */
class FakeObserver {
  static all: FakeObserver[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.all.push(this);
  }
  observe() {}
  disconnect() {}
  enter() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

const poster = (id: string) => ({ mediaId: id, key: 'k', iv: 'i', mimeType: 'image/png' });
const space = (id: string, withPoster: boolean) =>
  ({
    id,
    name: `Espace ${id}`,
    description: null,
    associationId: null,
    associationName: 'BDA',
    timeZone: 'Europe/Paris',
    resourceCount: 1,
    poster: withPoster ? poster(`media-${id}`) : null,
  }) as unknown as ListedSpace;

const mounted: (() => void)[] = [];

async function open(spaces: ListedSpace[]) {
  const app = mount(SpaceList, { target: document.body, props: { spaces, label: 'Espaces' } });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
}

beforeEach(() => {
  FakeObserver.all = [];
  download.mockReset();
  download.mockResolvedValue('blob:thumb');
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SpaceList - the poster as a thumbnail', () => {
  it('decrypts nothing until a thumbnail is near the viewport, then only that one', async () => {
    await open([space('a', true), space('b', true), space('c', true)]);
    expect(download).not.toHaveBeenCalled();
    FakeObserver.all[1].enter();
    flushSync();
    await tick();
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0]).toMatchObject({ mediaId: 'media-b' });
  });

  it('draws the decrypted picture in the row once it has arrived', async () => {
    await open([space('a', true)]);
    FakeObserver.all[0].enter();
    flushSync();
    await tick();
    await tick();
    expect(document.querySelector('a[data-hub-row="a"] img')?.getAttribute('src')).toBe(
      'blob:thumb'
    );
  });

  it('keeps a glyph in the same box for a space with no poster, and fetches nothing', async () => {
    await open([space('a', false)]);
    expect(FakeObserver.all).toHaveLength(0);
    expect(download).not.toHaveBeenCalled();
    expect(document.querySelector('a[data-hub-row="a"] img')).toBeNull();
    expect(document.querySelector('a[data-hub-row="a"] svg')).not.toBeNull();
  });

  it('is a real link to the space, named by its name', async () => {
    await open([space('a', true)]);
    const link = document.querySelector<HTMLAnchorElement>('a[data-hub-row="a"]')!;
    expect(link.getAttribute('href')).toContain('a');
    expect(link.textContent).toContain('Espace a');
  });
});
