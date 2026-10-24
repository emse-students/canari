// @vitest-environment happy-dom
/**
 * THE PAYMENT PROVIDER IS SAVED AND THE RELEASE BEHIND IT FAILED. core-service answers that 502
 * with a typed code and the saved config; the screen must say the provider WAS saved (not "could
 * not save"), adopt the saved config as its snapshot, and offer the explicit release action - which
 * is the only retry, since after a reload the form sends no provider at all.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const admin = vi.hoisted(() => ({ value: true }));
const apiFetch = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => admin.value }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({ refreshAppVersionCheck: refresh }));

import Page from './+page.svelte';
import { m } from '$lib/paraglide/messages';

type Provider = 'lydia' | 'disabled';
const config = (paymentProvider: Provider) => ({
  maintenanceEnabled: false,
  maintenanceMessage: null,
  minClientVersion: '1.2.7',
  paymentProvider,
  callsMode: 'audio',
});

const mounted: (() => void)[] = [];

/** Answers the screen's calls: the load with `provider`, the PATCH and the release as given. */
function route(provider: Provider, patch: () => Response, release: () => Response) {
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return Promise.resolve(patch());
    if (init?.method === 'POST') return Promise.resolve(release());
    if (url.endsWith('/announcement')) {
      return Promise.resolve(new Response(JSON.stringify({ announcement: null }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(config(provider)), { status: 200 }));
  });
}

const incomplete = () =>
  new Response(
    JSON.stringify({
      statusCode: 502,
      code: 'WITHHELD_RELEASE_INCOMPLETE',
      message: 'Payment provider saved, but withheld products could not all be released',
      config: config('lydia'),
    }),
    { status: 502 }
  );

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    flushSync();
    await tick();
  }
};

async function render() {
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app));
  await settle();
}

const releaseButton = () => document.querySelector<HTMLButtonElement>('#release-withheld');
const callsWith = (method: string) =>
  apiFetch.mock.calls.filter(
    ([, init]) => (init as { method?: string } | undefined)?.method === method
  );

async function submit() {
  document
    .querySelector('#min-client-version')!
    .closest('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

beforeEach(() => {
  admin.value = true;
  apiFetch.mockReset();
  refresh.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('admin/platform - the withheld-product release', () => {
  it('maps WITHHELD_RELEASE_INCOMPLETE by code: provider saved, release incomplete, never "could not save"', async () => {
    route('disabled', incomplete, () => new Response('{}', { status: 200 }));
    await render();
    expect(releaseButton()).toBeNull();
    await submit();

    const alert = document.querySelector('[role="alert"]')?.textContent;
    expect(alert).toBe(m.admin_platform_release_incomplete());
    expect(alert).not.toBe(m.admin_platform_save_error());
    expect(document.body.textContent).not.toContain('could not all be released');
    // The saved config became the snapshot: the release action is now offered.
    expect(releaseButton()).not.toBeNull();
  });

  it('CONTROL: an untyped 502 is still the generic save error', async () => {
    route(
      'disabled',
      () => new Response(JSON.stringify({ statusCode: 502, message: 'x' }), { status: 502 }),
      () => new Response('{}', { status: 200 })
    );
    await render();
    await submit();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      m.admin_platform_save_error()
    );
    expect(releaseButton()).toBeNull();
  });

  it('the release button calls the dedicated route and reports the count, with no PATCH', async () => {
    route(
      'lydia',
      () => new Response('{}', { status: 200 }),
      () => new Response(JSON.stringify({ released: 3, failed: 0 }), { status: 200 })
    );
    await render();
    releaseButton()!.click();
    await settle();

    expect(callsWith('POST')).toHaveLength(1);
    expect(callsWith('POST')[0][0]).toBe(
      'https://core.test/api/users/admin/platform/release-withheld-products'
    );
    expect(callsWith('PATCH')).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      m.admin_platform_released_count({ count: 3 })
    );
  });

  it('a failed release shows the localized release error', async () => {
    route('lydia', () => new Response('{}', { status: 200 }), incomplete);
    await render();
    releaseButton()!.click();
    await settle();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      m.admin_platform_release_error()
    );
  });

  it('CONTROL: the release is not offered while the server holds payments disabled', async () => {
    route(
      'disabled',
      () => new Response('{}', { status: 200 }),
      () => new Response('{}', { status: 200 })
    );
    await render();
    expect(releaseButton()).toBeNull();
  });
});
