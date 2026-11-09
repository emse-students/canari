// @vitest-environment happy-dom
/**
 * THE PAGE OF ONE LIVE (`/lives/<id>`): a running live opens the viewer; an ended or invisible one
 * (the server's 404/410) says "this live has ended" in words, never a raw error; the way out is the
 * feed, by a replace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { LiveRefusalError } from '$lib/live/api';
import { m } from '$lib/paraglide/messages';

const h = vi.hoisted(() => ({ fetchLive: vi.fn(), goto: vi.fn(() => Promise.resolve()) }));

vi.mock('$app/state', () => ({
  page: { params: { liveId: 'live-1' }, url: new URL('https://c.test/lives/live-1') },
}));
vi.mock('$app/navigation', () => ({ goto: h.goto }));
vi.mock('$lib/live/api', async (orig) => ({
  ...(await orig<typeof import('$lib/live/api')>()),
  fetchLive: h.fetchLive,
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverLivesMode: () => 'on',
}));
vi.mock('$lib/features', async (orig) => ({
  ...(await orig<typeof import('$lib/features')>()),
  LIVE_ENABLED: true,
}));
vi.mock(
  '$lib/components/live/LiveViewer.svelte',
  async () => import('../../../test/stubs/LiveViewerStub.svelte')
);

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.goto.mockClear();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

describe('the live page', () => {
  it('opens the viewer on a running live', async () => {
    h.fetchLive.mockResolvedValue({
      id: 'live-1',
      broadcasterId: 'u1',
      associationId: null,
      startedAt: '2026-10-31T10:00:00.000Z',
    });
    await open();
    expect(h.fetchLive).toHaveBeenCalledWith('live-1');
    expect(document.querySelector('[data-stub="live-viewer"]')?.textContent).toBe('live-1');
  });

  it('says the live has ended on a 404, and leaves for the feed with a replace', async () => {
    h.fetchLive.mockRejectedValue(
      new LiveRefusalError(404, null, 'nf', 'not-found', null, null, null)
    );
    await open();
    const screen = document.querySelector<HTMLElement>('[data-live-route]')!;
    expect(screen.dataset.liveRoute).toBe('gone');
    expect(screen.textContent).toContain(m.live_route_gone_title());
    document.querySelector<HTMLButtonElement>('[data-live-route-back]')!.click();
    expect(h.goto).toHaveBeenCalledWith(expect.stringContaining('/posts'), { replaceState: true });
  });

  it('offers a retry on a failed link', async () => {
    h.fetchLive.mockRejectedValue(
      new LiveRefusalError(503, null, 'x', 'seats-unavailable', null, null, null)
    );
    await open();
    expect(document.querySelector('[data-live-route-retry]')).not.toBeNull();
  });
});
