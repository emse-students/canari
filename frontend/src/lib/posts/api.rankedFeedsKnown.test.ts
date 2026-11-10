/**
 * POUR TOI IS NEVER ASKED AS ANOTHER LIST BECAUSE THE ESTATE WAS NOT KNOWN YET (alpha.6, 2026-11-10):
 * the capability is `null` on every cold start until `/api/version` answers, and a ranked list
 * waits for that answer instead of reading the absence as "no".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const capability = vi.hoisted(() => ({ value: null as boolean | null, afterCheck: true }));
const refresh = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  serverLiveReplaysMode: () => 'off',
  serverRankedFeeds: () => capability.value,
  refreshAppVersionCheck: refresh,
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.urls.push(url);
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

import { listPosts } from './api';

beforeEach(() => {
  calls.urls = [];
  capability.value = null;
  refresh.mockReset().mockImplementation(async () => {
    capability.value = capability.afterCheck;
  });
});

describe('a ranked list on an estate not known yet', () => {
  it('waits for the version check, then asks Pour toi itself - never the old followed list', async () => {
    capability.afterCheck = true;
    await listPosts({ feed: 'foryou', limit: 20 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.urls[0]).toContain('feed=foryou');
    expect(calls.urls[0]).not.toContain('followed');
  });

  it('asks the older shape only when the estate SAYS it serves no ranked list', async () => {
    capability.afterCheck = false;
    await listPosts({ feed: 'foryou', limit: 20 });
    expect(calls.urls[0]).toContain('feed=followed');
  });

  it('a known capability and an unranked list ask at once', async () => {
    capability.value = true;
    await listPosts({ feed: 'foryou', limit: 20 });
    capability.value = null;
    await listPosts({ feed: 'associations', limit: 20 });
    expect(refresh).not.toHaveBeenCalled();
  });
});
