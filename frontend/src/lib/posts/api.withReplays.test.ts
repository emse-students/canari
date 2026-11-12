/**
 * THE CLIENT ASKS FOR REPLAYS ONLY WHEN THE SERVER SWITCH READS ON (owner, 2026-11-09): `withReplays`
 * is on the wire exactly then, on the lists and on a post read by id; a list that cannot draw one
 * passes `false`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ value: 'off' as 'off' | 'on' }));
const calls = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  serverLiveReplaysMode: () => mode.value,
  serverRankedFeeds: () => false,
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

import { buildListPostsSearchParams, getPost, listPosts } from './api';

beforeEach(() => {
  calls.urls = [];
  mode.value = 'off';
});

describe('withReplays', () => {
  it('is in the query only when asked', () => {
    expect(buildListPostsSearchParams({ withReplays: true })).toBe('?withReplays=true');
    expect(buildListPostsSearchParams({ withReplays: false })).toBe('');
    expect(buildListPostsSearchParams({})).toBe('');
  });
  it('listPosts never asks with the switch off', async () => {
    await listPosts({ kind: 'reel' });
    expect(calls.urls[0]).not.toContain('withReplays');
  });
  it('listPosts asks with the switch on, unless the caller says it cannot draw one', async () => {
    mode.value = 'on';
    await listPosts({ kind: 'reel' });
    await listPosts({ withReplays: false });
    expect(calls.urls[0]).toContain('withReplays=true');
    expect(calls.urls[1]).not.toContain('withReplays');
  });
  it('getPost asks only with the switch on', async () => {
    await getPost('p1').catch(() => {});
    mode.value = 'on';
    await getPost('p2').catch(() => {});
    expect(calls.urls[0]).not.toContain('withReplays');
    expect(calls.urls[1]).toContain('withReplays=true');
  });
});
