// @vitest-environment happy-dom
/**
 * THE LIVES KILL SWITCH ON /admin/platform - the same safety as the calls control
 * (`page.minClientVersion.svelte.test.ts`): it shows what the server holds, a move sends ONLY that
 * field, an unrelated save never names it (a stale form must not re-open what another admin closed),
 * and nothing is sent when nothing was loaded. The refusal itself, the actor line and the global-admin
 * guard are core-service's (platform.service.spec.ts, platform-admin.controller.ts).
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const goto = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => true }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({ refreshAppVersionCheck: refresh }));

import Page from './+page.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The picker's panel leaves by an outro when an option is chosen.
afterAll(adoptTransitionAnimations());

const CONFIG = {
  maintenanceEnabled: false,
  maintenanceMessage: null,
  minClientVersion: '1.2.7',
  paymentProvider: 'disabled',
  callsMode: 'audio',
  livesMode: 'off',
};

const mounted: (() => void)[] = [];

/** Answers the screen's three calls; a PATCH echoes the config with the body merged in. */
function route(loadOk = true) {
  apiFetch.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({ ...CONFIG, ...body }), { status: 200 }));
    }
    if (url.endsWith('/announcement')) {
      return Promise.resolve(new Response(JSON.stringify({ announcement: null }), { status: 200 }));
    }
    return Promise.resolve(
      loadOk
        ? new Response(JSON.stringify(CONFIG), { status: 200 })
        : new Response('down', { status: 500 })
    );
  });
}

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

const trigger = () => document.querySelector<HTMLButtonElement>('#lives-mode')!;
const patchBodies = () =>
  apiFetch.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse((init as { body: string }).body) as unknown);

async function pickLives(label: string) {
  trigger().click();
  await settle();
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (o) => o.textContent?.trim() === label
  );
  expect(option, `no option ${label}`).toBeDefined();
  option!.click();
  await settle();
}

async function submit() {
  trigger().form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

beforeEach(() => {
  goto.mockReset();
  apiFetch.mockReset();
  refresh.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('admin/platform livesMode', () => {
  it('shows the mode the server holds', async () => {
    route();
    await render();

    expect(document.body.textContent).toContain(m.admin_platform_lives_mode_label());
    expect(trigger().textContent).toContain(m.admin_platform_lives_mode_off());
  });

  it('opening lives sends livesMode alone, then confirms and refreshes the version check', async () => {
    route();
    await render();
    await pickLives(m.admin_platform_lives_mode_on());
    await submit();

    expect(patchBodies()).toEqual([{ livesMode: 'on' }]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      m.admin_platform_saved_label()
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(trigger().textContent).toContain(m.admin_platform_lives_mode_on());
  });

  it('an unrelated save never names the lives kill switch', async () => {
    route();
    await render();
    const version = document.querySelector<HTMLInputElement>('#min-client-version')!;
    version.value = '1.2.8';
    version.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    await submit();

    expect(patchBodies()).toEqual([{ minClientVersion: '1.2.8' }]);
  });

  it('refuses to save when nothing was loaded, and sends nothing', async () => {
    route(false);
    await render();
    await submit();

    expect(patchBodies()).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      m.admin_platform_save_needs_load()
    );
  });
});
