// @vitest-environment happy-dom
/**
 * The post-notification store polls every minute; offline, each poll got no answer and each one
 * logged a warning (Mi 9T offline cold start, `v1.2.9-alpha.1`, 2026-10-15). A load with no answer
 * is the link, said once per spell; any other failure is the route's, and warns every time.
 */
import { getPostNotifications, type PostNotification } from '$lib/posts/api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  dismissDeviceNotice,
  forgetDeviceNotices,
  loadDeviceNotices,
} from '$lib/utils/chat/deviceNotices.svelte';
import { postNotifStore } from './postNotifStore.svelte';

vi.mock('$lib/posts/api', () => ({
  getPostNotifications: vi.fn(),
  markPostNotificationsRead: vi.fn(),
  markPostNotificationsReadForPost: vi.fn(),
}));

const load = vi.mocked(getPostNotifications);

describe('postNotifStore.load', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('says an unanswered spell once, and again only after an answer ended it', async () => {
    load.mockRejectedValue(new TransportFailureError('error sending request'));
    await postNotifStore.load();
    await postNotifStore.load();
    await postNotifStore.load();
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);

    load.mockResolvedValueOnce([] as PostNotification[]);
    await postNotifStore.load();
    load.mockRejectedValue(new TransportFailureError(new TypeError('Failed to fetch')));
    await postNotifStore.load();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('counts the new-device alerts of this device in the unread badge', async () => {
    localStorage.setItem(
      ACCOUNT_KEY.deviceNotices('alice'),
      JSON.stringify({ pending: [{ key: 'alice:d|cc', deviceId: 'd', at: 1 }], announced: [] })
    );
    forgetDeviceNotices();
    const before = postNotifStore.unread;
    loadDeviceNotices('alice');
    expect(postNotifStore.unread).toBe(before + 1);
    dismissDeviceNotice('alice:d|cc');
    expect(postNotifStore.unread).toBe(before);
    forgetDeviceNotices();
  });

  it('warns on every refused load - an answer, not the link', async () => {
    load.mockRejectedValue(new ApiRefusalError(500, null, 'post-service 500'));
    await postNotifStore.load();
    await postNotifStore.load();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
