// @vitest-environment happy-dom
/**
 * THE RETENTION-APPLIED NOTICE, MOUNTED IN THE PAGE (delta review of #3554): the other page tests mock
 * the notice; this one routes every URL, and shows that a save bumps the notice's revision, so its
 * state is read again - a change saved here is checked against what media-service holds at once.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const goto = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => true }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
// The Lydia contract panel reads its own routes; its test is LydiaContractPanel.svelte.test.ts.
vi.mock('$lib/components/admin/LydiaContractPanel.svelte', () => ({ default: () => {} }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({ refreshAppVersionCheck: vi.fn() }));

import Page from './+page.svelte';
import { m } from '$lib/paraglide/messages';

const CONFIG = {
  maintenanceEnabled: false,
  maintenanceMessage: null,
  minClientVersion: '1.2.7',
  paymentProvider: 'disabled',
  callsMode: 'audio',
  livesMode: 'off',
  pushMode: 'full',
  retentionReelDays: 365,
  retentionLiveReplayDays: 3,
  retentionChatReelDays: 30,
  retentionIdleFileDays: 90,
};

const APPLIED_URL = 'https://core.test/api/users/admin/platform/retention-applied';
const mounted: (() => void)[] = [];
/** What core answers for the retention-applied state, in order. */
let states: string[] = [];

function route() {
  apiFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (url === APPLIED_URL) return json({ state: states.shift() ?? 'applied', refusal: null });
    if (url.endsWith('/announcement')) return json({ announcement: null });
    if (init?.method === 'PATCH') {
      return json({ ...CONFIG, ...(JSON.parse(init.body ?? '{}') as object) });
    }
    if (url === 'https://core.test/api/users/admin/platform') return json(CONFIG);
    return Promise.resolve(new Response('not routed', { status: 404 }));
  });
}

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    flushSync();
    await tick();
  }
};

const appliedReads = () => apiFetch.mock.calls.filter(([url]) => url === APPLIED_URL).length;
const notice = () => document.querySelector<HTMLElement>('[data-retention-applied]');

beforeEach(() => {
  apiFetch.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('admin/platform - the retention-applied notice', () => {
  it('reads the state after the load, and again after a save', async () => {
    states = ['applied', 'behind'];
    route();
    const app = mount(Page, { target: document.body });
    mounted.push(() => unmount(app));
    await settle();
    expect(appliedReads()).toBe(1);
    expect(notice()).toBeNull();

    const chatReel = document.querySelector<HTMLInputElement>('#retention-retentionChatReelDays')!;
    chatReel.value = '7';
    chatReel.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    chatReel.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();

    expect(appliedReads()).toBe(2);
    expect(notice()?.textContent).toContain(m.admin_platform_retention_not_applied());
  });
});
