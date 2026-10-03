import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const pending = new Map<string, { resolve: (url: string) => void }>();

vi.mock('$lib/media', () => ({
  MediaService: class {
    downloadRaw(mediaId: string): Promise<string> {
      return new Promise((resolve) => pending.set(mediaId, { resolve }));
    }
  },
}));

vi.mock('$lib/utils/mediaBlobCache', () => ({
  releaseRawMediaBlobUrl: vi.fn(),
}));

import RaceHost from './GroupAvatar.race.test-host.svelte';
import { releaseRawMediaBlobUrl } from '$lib/utils/mediaBlobCache';

const mounted: (() => void)[] = [];

beforeEach(() => pending.clear());
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function mountAvatar() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(RaceHost, { target });
  mounted.push(() => unmount(app));
  flushSync();
  return app;
}

describe('GroupAvatar media transitions', () => {
  it('does not restore an avatar after its id is cleared', async () => {
    const app = mountAvatar();
    app.setImageMediaId(null);
    flushSync();
    pending.get('old')?.resolve('blob:old');
    await Promise.resolve();
    flushSync();

    expect(document.querySelector('img')).toBeNull();
    expect(releaseRawMediaBlobUrl).toHaveBeenCalledWith('old');
  });

  it('does not show the previous avatar while the replacement is loading', () => {
    const app = mountAvatar();
    pending.get('old')?.resolve('blob:old');
    flushSync();
    app.setImageMediaId('new');
    flushSync();

    expect(document.querySelector('img')).toBeNull();
    expect(pending.has('new')).toBe(true);
  });
});
