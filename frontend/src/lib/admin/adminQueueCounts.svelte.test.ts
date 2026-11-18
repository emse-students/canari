// @vitest-environment happy-dom
/**
 * THE ADMIN BADGES' ONE SOURCE (owner, 2026-11-18): the server's pending counts, read from
 * `GET /api/moderation/admin-queues` and nothing else. Pinned: only known keys with a whole count are
 * kept (a malformed answer draws no badge); the Administration entry is the SUM of what the reader
 * can act on; a call made while one is in flight sends ONE more after it (the first may have left
 * before the caller's change committed); an answer for an account that ended is dropped; no answer
 * or a refusal keeps the counts drawn (a wrong zero would hide waiting items).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TransportFailureError } from '$lib/utils/transportFailure';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ socialUrl: () => 'https://social.test' }));
const account = vi.hoisted(() => ({ id: 'adm' as string | null }));
vi.mock('$lib/stores/userState.svelte', () => ({ currentUserId: () => account.id }));
const ended = vi.hoisted(() => ({ listeners: [] as (() => void)[] }));
vi.mock('$lib/utils/users/peerNameDirectory', () => ({
  onPeerNamesEnded: (l: () => void) => ended.listeners.push(l),
}));

import {
  adminQueueCounts,
  followAdminQueueCounts,
  loadAdminQueueCounts,
  readAdminQueueCounts,
} from './adminQueueCounts.svelte';

const answer = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

describe('adminQueueCounts', () => {
  beforeEach(async () => {
    account.id = 'adm';
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(answer(200, { counts: {} }));
    await loadAdminQueueCounts();
    apiFetch.mockReset();
  });

  it('keeps only the known queues holding a whole count', () => {
    expect(
      readAdminQueueCounts({
        counts: { agenda: 2, moderation: -1, 'profile-corrections': 1.5, other: 9 },
      })
    ).toEqual({ agenda: 2 });
    expect(readAdminQueueCounts(null)).toEqual({});
    expect(readAdminQueueCounts({ counts: 'x' })).toEqual({});
  });

  it('asks the one endpoint, and the Administration entry is the sum of the queues held', async () => {
    apiFetch.mockResolvedValueOnce(
      answer(200, { counts: { agenda: 1, moderation: 3, 'profile-corrections': 2 } })
    );
    await loadAdminQueueCounts();
    expect(apiFetch).toHaveBeenCalledWith('https://social.test/api/moderation/admin-queues');
    expect(adminQueueCounts.counts).toEqual({ agenda: 1, moderation: 3, 'profile-corrections': 2 });
    expect(adminQueueCounts.total).toBe(6);
  });

  it('a BDE moderator is counted its reports only: the sum is that one queue', async () => {
    apiFetch.mockResolvedValueOnce(answer(200, { counts: { moderation: 4 } }));
    await loadAdminQueueCounts();
    expect(adminQueueCounts.total).toBe(4);
    expect(adminQueueCounts.counts['profile-corrections']).toBeUndefined();
  });

  it('calls made while one is in flight send ONE more after it, never answered by the stale one', async () => {
    let release!: (r: Response) => void;
    apiFetch.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    apiFetch.mockResolvedValueOnce(answer(200, { counts: { agenda: 0 } }));
    const first = loadAdminQueueCounts();
    void loadAdminQueueCounts();
    void loadAdminQueueCounts();
    release(answer(200, { counts: { agenda: 1 } }));
    await first;
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(adminQueueCounts.total).toBe(0);
  });

  it('an answer that lands after the account ended draws nothing for the next one', async () => {
    let release!: (r: Response) => void;
    apiFetch.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    const pending = loadAdminQueueCounts();
    for (const l of ended.listeners) l();
    account.id = 'member';
    release(answer(200, { counts: { moderation: 7 } }));
    await pending;
    expect(adminQueueCounts.total).toBe(0);
  });

  it('no answer, or a refusal, keeps the counts drawn', async () => {
    apiFetch.mockResolvedValueOnce(answer(200, { counts: { moderation: 2 } }));
    await loadAdminQueueCounts();
    apiFetch.mockRejectedValueOnce(new TransportFailureError(new Error('offline')));
    await loadAdminQueueCounts();
    expect(adminQueueCounts.total).toBe(2);
    apiFetch.mockResolvedValueOnce(answer(503));
    await loadAdminQueueCounts();
    expect(adminQueueCounts.total).toBe(2);
  });

  it('a follow asks at once, and its cleanup stops it', async () => {
    apiFetch.mockResolvedValue(answer(200, { counts: { agenda: 3 } }));
    const stop = followAdminQueueCounts();
    await vi.waitFor(() => expect(adminQueueCounts.total).toBe(3));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    stop();
  });
});
