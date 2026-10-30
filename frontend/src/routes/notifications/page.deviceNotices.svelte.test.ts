// @vitest-environment happy-dom
/**
 * THE DEVICE ALERTS LIVE IN `/notifications` (owner decision 2026-10-30), not in an app-wide banner.
 * "A new device was added to your account" is a local entry of the list - built on this device from a
 * signed commit, counted in the bell's badge, never sent to the server - and "Not me" revokes. The
 * refused-device alert is shown nowhere: the detection stays, as a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import {
  forgetDeviceNotices,
  loadDeviceNotices,
  noteRefusedOwnDevices,
  pendingDeviceNotices,
} from '$lib/utils/chat/deviceNotices.svelte';
import { flushMacrotask } from '../../test/flush';

const hoisted = vi.hoisted(() => ({
  revoke: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  postNotifs: { notifications: [] as unknown[], loading: false },
}));

vi.mock('$lib/utils/chat/deviceNoticeWiring', () => ({ revokeNoticedDevice: hoisted.revoke }));
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: hoisted.confirm }));
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: hoisted.toast }));
vi.mock('$lib/proposals/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/proposals/api')>()),
  countMyRepublicationRequests: vi.fn(() => Promise.resolve(0)),
}));
vi.mock('$lib/follows/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/follows/api')>()),
  countFollowRequests: vi.fn(() => Promise.resolve(0)),
}));
vi.mock('$lib/stores/postNotifStore.svelte', () => ({
  postNotifStore: {
    get notifications() {
      return hoisted.postNotifs.notifications;
    },
    loading: false,
    load: vi.fn(() => Promise.resolve()),
    markAllRead: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import Page from './+page.svelte';

const NOW = 1_700_000_000_000;
const seed = () => {
  localStorage.setItem(
    ACCOUNT_KEY.deviceNotices('alice'),
    JSON.stringify({
      pending: [
        { key: 'alice:laptop-9|cc', deviceId: 'laptop-9', at: NOW, label: 'Firefox on Linux' },
      ],
      announced: ['alice:laptop-9|cc'],
    })
  );
  loadDeviceNotices('alice');
};

const mounted: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  forgetDeviceNotices();
  hoisted.revoke.mockReset();
  hoisted.confirm.mockReset();
  hoisted.toast.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  forgetDeviceNotices();
  vi.restoreAllMocks();
});

async function render(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  await flushMacrotask();
  flushSync();
  return target;
}

describe('/notifications, the new-device alert', () => {
  it('is an entry of the list, with the device name and the way to act', async () => {
    seed();
    const target = await render();
    const row = target.querySelector('[data-device-notice]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(m.device_notice_title());
    expect(row?.textContent).toContain('Firefox on Linux');
    expect(row?.querySelector('[data-device-notice-not-me]')).not.toBeNull();
    // The list is not "empty" while an alert waits.
    expect(target.textContent).not.toContain(m.notif_empty_message());
  });

  it('draws nothing when no device was added', async () => {
    const target = await render();
    expect(target.querySelector('[data-device-notice]')).toBeNull();
  });

  it('"Got it" removes it, and it stays gone after a reload', async () => {
    seed();
    const target = await render();
    (target.querySelector('[data-device-notice-dismiss]') as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector('[data-device-notice]')).toBeNull();
    forgetDeviceNotices();
    loadDeviceNotices('alice');
    expect(pendingDeviceNotices()).toEqual([]);
  });

  it('"Not me" revokes the device after a confirmation, and the row leaves with a toast', async () => {
    seed();
    hoisted.confirm.mockResolvedValue(true);
    hoisted.revoke.mockResolvedValue(true);
    const target = await render();
    (target.querySelector('[data-device-notice-not-me]') as HTMLButtonElement).click();
    await flushMacrotask();
    flushSync();
    expect(hoisted.confirm).toHaveBeenCalledTimes(1);
    expect(hoisted.revoke).toHaveBeenCalledWith('laptop-9');
    expect(hoisted.toast).toHaveBeenCalledWith(m.device_notice_not_me_done(), 'info');
    expect(target.querySelector('[data-device-notice]')).toBeNull();
  });

  it('"Not me" declined revokes nothing; a failed revocation keeps the row', async () => {
    seed();
    hoisted.confirm.mockResolvedValueOnce(false);
    const target = await render();
    const notMe = () => target.querySelector('[data-device-notice-not-me]') as HTMLButtonElement;
    notMe().click();
    await flushMacrotask();
    expect(hoisted.revoke).not.toHaveBeenCalled();

    hoisted.confirm.mockResolvedValueOnce(true);
    hoisted.revoke.mockResolvedValueOnce(false);
    notMe().click();
    await flushMacrotask();
    flushSync();
    expect(hoisted.toast).toHaveBeenCalledWith(m.device_notice_not_me_failed(), 'error');
    expect(target.querySelector('[data-device-notice]')).not.toBeNull();
  });
});

describe('a refused own device', () => {
  it('renders nowhere, and is logged as an error once per device', async () => {
    loadDeviceNotices('alice');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    noteRefusedOwnDevices(['alice:old', 'bob:x'], { ownUserId: 'alice' });
    noteRefusedOwnDevices(['alice:old'], { ownUserId: 'alice' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('refused');

    const target = await render();
    expect(target.querySelectorAll('[data-device-notice]')).toHaveLength(0);
  });
});
