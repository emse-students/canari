// @vitest-environment happy-dom
/**
 * THE STANDING OF A BROADCASTER IS READ WITHOUT A REPORT (1.7.0): the "Broadcast withdrawn" tab
 * lists the withdrawn accounts from `GET /api/lives/broadcasters/withdrawn` and lifts from there,
 * whatever status the reports naming them have; and the three success toasts of the live block are
 * drawn as success ('info'), never as the 'error' `showToast` defaults to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import type { LiveBroadcasterStanding } from '$lib/live/types';

vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/admin/moderation'), params: {}, state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));
vi.mock('$lib/stores/auth', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/auth')>()),
  getToken: () => Promise.resolve('token'),
}));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/user')>()),
  isGlobalAdmin: () => true,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: (id: string) => Promise.resolve(id),
}));
vi.mock('$lib/components/shared/Avatar.svelte', async () => ({
  default: (await import('$lib/components/ui/Button.svelte')).default,
}));
const h = vi.hoisted(() => ({
  listReports: vi.fn(),
  fetchWithdrawnBroadcasters: vi.fn(),
  liftBroadcasterWithdrawal: vi.fn(),
  showConfirm: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('$lib/moderation/api', async (orig) => ({
  ...(await orig<typeof import('$lib/moderation/api')>()),
  listReports: h.listReports,
}));
vi.mock('$lib/live/api', async (orig) => ({
  ...(await orig<typeof import('$lib/live/api')>()),
  fetchWithdrawnBroadcasters: h.fetchWithdrawnBroadcasters,
  liftBroadcasterWithdrawal: h.liftBroadcasterWithdrawal,
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: h.showConfirm }));
vi.mock('$lib/stores/toast.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/toast.svelte')>()),
  showToast: h.showToast,
}));

import Page from './+page.svelte';

const withdrawn = (userId: string): LiveBroadcasterStanding => ({
  userId,
  displayName: `Name ${userId}`,
  cutsOnRecord: 3,
  suspendedUntil: null,
  withdrawnAt: '2026-11-10T10:00:00.000Z',
  withdrawalDue: false,
  withdrawalReason: 'harassment',
});

const mounted: (() => void)[] = [];
beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

const tabButton = () =>
  [...document.querySelectorAll('button, [role="tab"]')].find((b) =>
    b.textContent?.includes(m.moderation_withdrawn_tab())
  ) as HTMLElement | undefined;

async function openWithdrawnTab() {
  h.listReports.mockResolvedValue([]);
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await vi.waitFor(() => expect(h.listReports).toHaveBeenCalled());
  await settle();
  tabButton()!.click();
  await settle();
}

describe('the withdrawn broadcasters tab', () => {
  it('lists the withdrawn accounts although no report names them', async () => {
    h.fetchWithdrawnBroadcasters.mockResolvedValue([withdrawn('u1'), withdrawn('u2')]);
    await openWithdrawnTab();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-moderation-withdrawn-row]')).toHaveLength(2)
    );
  });

  it('lifts from the list, tells it as a success toast, and reads the list again', async () => {
    h.fetchWithdrawnBroadcasters.mockResolvedValueOnce([withdrawn('u1')]);
    h.fetchWithdrawnBroadcasters.mockResolvedValueOnce([]);
    h.showConfirm.mockResolvedValue(true);
    h.liftBroadcasterWithdrawal.mockResolvedValue({ userId: 'u1', lifted: true });
    await openWithdrawnTab();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-moderation-live-lift]')).not.toBeNull()
    );
    document.querySelector<HTMLButtonElement>('[data-moderation-live-lift]')!.click();
    await settle();
    expect(h.liftBroadcasterWithdrawal).toHaveBeenCalledWith('u1');
    // A success is drawn as one: 'info', never the 'error' default.
    expect(h.showToast).toHaveBeenCalledWith(m.moderation_live_lift_done(), 'info');
    await vi.waitFor(() =>
      expect(document.querySelector('[data-moderation-withdrawn-empty]')).not.toBeNull()
    );
  });

  it('says the list could not be loaded instead of an empty one', async () => {
    h.fetchWithdrawnBroadcasters.mockRejectedValue(new Error('network'));
    await openWithdrawnTab();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(m.moderation_load_withdrawn_error())
    );
  });
});
