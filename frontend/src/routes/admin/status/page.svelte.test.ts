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
  vi.resetAllMocks();
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
  await vi.waitFor(() => expect(page.querySelector('[role="slider"]')).not.toBeNull());

  expect(page.querySelector('[data-testid="status-users"]')?.textContent?.trim()).toBe('3');
  expect(page.querySelector('[data-testid="status-devices"]')?.textContent?.trim()).toBe('4');

  const versions = [...page.querySelectorAll('[data-testid="status-version"]')];
  expect(versions).toHaveLength(2);
  expect(versions[0].textContent).toContain('1.5.4');
  expect(versions[0].textContent).toContain('75');
  expect(page.querySelectorAll('svg polygon').length).toBeGreaterThan(0);
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

async function mockedFetch() {
  const { apiFetch } = await import('$lib/utils/apiFetch');
  return vi.mocked(apiFetch);
}

it('keeps a history failure on screen when the live counts then succeed', async () => {
  seed();
  const fetch = await mockedFetch();
  fetch.mockImplementation((url: string | URL | Request) =>
    Promise.resolve(
      String(url).endsWith('/history')
        ? new Response('{}', { status: 500 })
        : new Response(JSON.stringify(responses.now), { status: 200 })
    )
  );
  const page = await render();
  const banner = () => page.querySelector('[class*="border-red-err"]');
  await vi.waitFor(() => expect(banner()).not.toBeNull());

  // A second live read succeeds; the history source is still failing and the banner must say so.
  const before = fetch.mock.calls.length;
  page.querySelector<HTMLButtonElement>('button')?.click();
  await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  expect(banner()).not.toBeNull();
});

it('stops polling while the tab is hidden and reads again when it is shown', async () => {
  seed();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fetch = await mockedFetch();
  fetch.mockClear();
  const page = await render();
  const calls = () => fetch.mock.calls.length;
  expect(calls()).toBe(2);

  const hide = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  hide(true);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(calls()).toBe(2);

  hide(false);
  expect(calls()).toBe(4);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls()).toBe(5);
  expect(page.querySelector('[data-testid="status-devices"]')).not.toBeNull();
  vi.useRealTimers();
});

it('gives the chart readout to the keyboard', async () => {
  seed();
  const page = await render();
  const chart = await vi.waitFor(() => {
    const svg = page.querySelector<HTMLElement>('[role="slider"]');
    expect(svg).not.toBeNull();
    return svg!;
  });
  const readout = () => page.querySelector('[role="slider"]')?.getAttribute('aria-valuetext') ?? '';
  expect(chart.getAttribute('tabindex')).toBe('0');
  expect(readout()).toBe('');

  chart.dispatchEvent(new FocusEvent('focus'));
  await vi.waitFor(() => expect(readout()).not.toBe(''));
  const latest = readout();

  chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await vi.waitFor(() => expect(readout()).not.toBe(latest));

  chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await vi.waitFor(() => expect(readout()).toBe(''));
});
