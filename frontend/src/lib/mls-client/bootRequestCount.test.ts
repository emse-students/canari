import { beforeEach, describe, expect, it } from 'vitest';
import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';
import { reconcileSalonUnreadFromServer, resetSalonUnread } from '../utils/chat/salonUnread';
import type { Conversation } from '$lib/types';

/**
 * THE REQUEST COUNT OF A BOOT'S ACCOUNT-LEVEL READS (WP-W4). HAR 2026-10-18: a cold start sent
 * `unread-counts` twice, and `devices/<id>` three times - from the pending-invitation sweep, the
 * `welcome_request` answer and the group reconcile. Since 2026-11-06 none of those three reads the
 * account list: the sweep and the answer claim the ONE device they add (`fetchDeviceKeyPackage`),
 * the list is claimed only by the adders `deviceListClaims.test.ts` allows, and a claim is never
 * shared. So this no longer replays that recording's device reads. What it pins:
 *
 * - `unread-counts`: the community load and the live stream coming back send ONE request.
 * - the device list: the readers that may meet at a boot only to read the ROSTER (the device-notice
 *   pre-claim at registration, the settings device count, a device's name) share ONE `?peek=1`
 *   request, and none of them claims.
 *
 * Every caller goes through ONE recording `fetch`. No sleep and no clock: the callers run
 * concurrently and the answer is released by hand.
 */
describe('a recorded boot sends each account-level read once', () => {
  beforeEach(() => resetSalonUnread());

  it('sends ONE `unread-counts`, and ONE roster `devices` read that claims nothing', async () => {
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
      // the device-notice pre-claim at registration, the settings device count, a device's name
      api.listUserDevices('u1'),
      api.listUserDevices('u1'),
      api.listUserDevices('u1'),
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
    expect(urls.filter((u) => u.endsWith('/api/mls/devices/u1?peek=1'))).toHaveLength(1);
    // A claim of the list, or of one device, spends packages: no roster reader may send one.
    expect(urls.filter((u) => u.includes('/api/mls/devices/') && !u.endsWith('?peek=1'))).toEqual(
      []
    );
    expect(urls).toHaveLength(2);
  });
});
