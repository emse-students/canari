// @vitest-environment happy-dom
/**
 * THE STATUS PAGE IS COUNTS ONLY (owner, 2026-11-02): totals, the platforms, the versions live right
 * now and the last 24 hours. Whatever the gateway answers, the page has no per-person or per-device
 * row to draw - a stray `userId` in a response must not reach the DOM.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const goto = vi.hoisted(() => vi.fn());
const roles = vi.hoisted(() => ({ global: true }));
const NOW = 1_800_000_000 - (1_800_000_000 % 60);

const responses = vi.hoisted(() => ({
  now: {} as unknown,
  history: {} as unknown,
}));

vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => roles.global }));
vi.mock('$lib/utils/apiUrl', () => ({ gatewayUrl: () => 'https://gw.test' }));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify(url.endsWith('/history') ? responses.history : responses.now), {
        status: 200,
      })
    )
  ),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  roles.global = true;
});

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="status-devices"]')).not.toBeNull()
  );
  return target;
}

function seed() {
  responses.now = {
    devices: 4,
    users: 3,
    groups: [
      { platform: 'android', version: '1.5.4', devices: 2, users: 2 },
      { platform: 'web', version: '1.5.4', devices: 1, users: 1 },
      { platform: 'ios', version: '1.5.3', devices: 1, users: 1 },
    ],
    // A response that ever carried identities must still not put them on screen.
    userId: 'must-not-render-user',
    deviceId: 'must-not-render-device',
  };
  responses.history = {
    now: NOW,
    intervalSecs: 60,
    windowSecs: 24 * 60 * 60,
    samples: [
      {
        t: NOW - 120,
        devices: 3,
        users: 3,
        groups: [{ platform: 'web', version: '1.5.4', devices: 3, users: 3 }],
      },
      {
        t: NOW,
        devices: 4,
        users: 3,
        groups: [{ platform: 'web', version: '1.5.4', devices: 4, users: 3 }],
      },
    ],
  };
}

it('shows the totals, the versions with their share, and the 24-hour chart', async () => {
  seed();
  const page = await render();
  await vi.waitFor(() => expect(page.querySelector('svg[role="img"]')).not.toBeNull());

  expect(page.querySelector('[data-testid="status-users"]')?.textContent?.trim()).toBe('3');
  expect(page.querySelector('[data-testid="status-devices"]')?.textContent?.trim()).toBe('4');

  const versions = [...page.querySelectorAll('[data-testid="status-version"]')];
  expect(versions).toHaveLength(2);
  expect(versions[0].textContent).toContain('1.5.4');
  expect(versions[0].textContent).toContain('75');
  expect(page.querySelectorAll('svg[role="img"] polygon').length).toBeGreaterThan(0);
});

it('draws no list of people or devices, and no identifier', async () => {
  seed();
  const page = await render();

  expect(page.querySelector('table')).toBeNull();
  expect(page.textContent).not.toContain('must-not-render');
});

it('sends a non-admin back to the admin home without asking the gateway anything', async () => {
  roles.global = false;
  seed();
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));

  await vi.waitFor(() => expect(goto).toHaveBeenCalled());
  const { apiFetch } = await import('$lib/utils/apiFetch');
  expect(apiFetch).not.toHaveBeenCalled();
});
