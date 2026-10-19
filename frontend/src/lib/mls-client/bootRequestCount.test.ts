import { beforeEach, describe, expect, it } from 'vitest';
import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';
import { reconcileSalonUnreadFromServer, resetSalonUnread } from '../utils/chat/salonUnread';
import type { Conversation } from '$lib/types';

/**
 * THE REQUEST COUNT OF A RECORDED BOOT (WP-W4). HAR 2026-10-18: a cold start sent `devices/<id>`
 * three times and `unread-counts` twice. Every caller of the boot path below goes through ONE
 * recording `fetch`, in the order the boot raises them, and the test pins how many requests reach the
 * wire. No sleep and no clock: the callers run concurrently and the answer is released by hand.
 */
describe('a recorded boot sends each account-level read once', () => {
  beforeEach(() => resetSalonUnread());

  it('sends exactly ONE `unread-counts` and ONE `devices` request', async () => {
    const urls: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const recordingFetch: MlsDeliveryFetch = async (input) => {
      urls.push(String(input));
      await gate;
      const body = String(input).includes('unread-counts') ? { asOf: 1, counts: {} } : [];
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const api = new MlsDeliveryApi({
      historyUrl: 'https://test.local',
      getToken: async () => 'tok',
      fetchImpl: recordingFetch,
    });
    const conversations = new Map<string, Conversation>();
    const unread = (reason: string) =>
      reconcileSalonUnreadFromServer({
        conversations,
        selectedId: null,
        userId: 'u1',
        reason,
        log: () => {},
        fetchCounts: async () =>
          (await recordingFetch('https://test.local/api/channels/unread-counts')).json(),
        // Nothing owed on a cold start: the flush delivers no mark.
        settleOwedMarks: async () => 0,
      });

    const boot = Promise.all([
      // the pending-invitation sweep, the welcome-request answer, the group reconcile
      api.fetchUserDevices('u1'),
      api.fetchUserDevices('u1'),
      api.fetchUserDevices('u1'),
      // the community load, then the live stream coming back
      unread('community load'),
      unread('live stream back'),
    ]);
    // Let every caller reach its request before the answer is released.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    release();
    await boot;

    expect(urls.filter((u) => u.endsWith('/api/channels/unread-counts'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u1'))).toHaveLength(1);
  });
});
