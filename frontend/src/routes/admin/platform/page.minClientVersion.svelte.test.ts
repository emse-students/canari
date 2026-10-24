// @vitest-environment happy-dom
/**
 * THE /admin/platform SCREEN, the one control that can lock out every client (mechanism-audit,
 * finding 3). The CEILING itself (a `minClientVersion` above the server's own version) lives on the
 * server and is pinned in core-service's platform.service.spec.ts; the screen does not know the
 * server's version, so it cannot block a submit above it. What the screen owns, pinned here: the
 * refusal the server sends back is shown as a Paraglide-worded alert and NEVER as the server's raw
 * English prose, a refused save claims no success and does not refresh the version check, the value
 * sent is trimmed, and a non-admin is sent away before any request.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const admin = vi.hoisted(() => ({ value: true }));
const goto = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => admin.value }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({ refreshAppVersionCheck: refresh }));

import Page from './+page.svelte';
import { m } from '$lib/paraglide/messages';

const CONFIG = {
  maintenanceEnabled: false,
  maintenanceMessage: null,
  minClientVersion: '1.2.7',
  paymentProvider: 'disabled',
  callsMode: 'audio',
  livesMode: 'on',
};
const CEILING_REFUSAL =
  "minClientVersion 9.9.9 is above this server's own version 1.3.0: no client that can satisfy it has been built, so every client would be locked out.";

/** The body Nest sends for a BadRequestException: JSON, so a missing `res.ok` guard would parse it as a config. */
const refusal = () =>
  new Response(
    JSON.stringify({ statusCode: 400, error: 'Bad Request', message: CEILING_REFUSAL }),
    { status: 400 }
  );

const mounted: (() => void)[] = [];

/** Answers the three calls the screen makes; `patch` decides what the save gets back. */
function route(patch: () => Response) {
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return Promise.resolve(patch());
    if (url.endsWith('/announcement')) {
      return Promise.resolve(new Response(JSON.stringify({ announcement: null }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(CONFIG), { status: 200 }));
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

const versionInput = () => document.querySelector<HTMLInputElement>('#min-client-version')!;
const patchCalls = () =>
  apiFetch.mock.calls.filter(
    ([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH'
  );

async function submitWith(value: string) {
  const input = versionInput();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

beforeEach(() => {
  admin.value = true;
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

describe('admin/platform minClientVersion', () => {
  it('shows a ceiling refusal as the Paraglide save error, never the server prose', async () => {
    route(() => refusal());
    await render();
    await submitWith('9.9.9');

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(m.admin_platform_save_error());
    expect(document.body.textContent).not.toContain('locked out');
    expect(document.body.textContent).not.toContain("server's own version");
  });

  it('claims no success and does not refresh the version check after a refusal', async () => {
    route(() => refusal());
    await render();
    await submitWith('9.9.9');

    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('sends the trimmed value, then confirms and refreshes the version check', async () => {
    route(
      () => new Response(JSON.stringify({ ...CONFIG, minClientVersion: '1.2.8' }), { status: 200 })
    );
    await render();
    await submitWith('  1.2.8  ');

    expect(patchCalls()).toHaveLength(1);
    const body = JSON.parse((patchCalls()[0][1] as { body: string }).body) as {
      minClientVersion: string;
    };
    expect(body.minClientVersion).toBe('1.2.8');
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      m.admin_platform_saved_label()
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // A STALE FORM MUST NOT UNDO ANOTHER ADMIN. The save used to PATCH every field as it was loaded,
  // so a page left open while someone else closed calls re-opened them on an unrelated save.
  it('sends only what changed: an unrelated save never names the calls kill switch', async () => {
    route(
      () => new Response(JSON.stringify({ ...CONFIG, minClientVersion: '1.2.8' }), { status: 200 })
    );
    await render();
    await submitWith('1.2.8');

    const body = JSON.parse((patchCalls()[0][1] as { body: string }).body) as unknown;
    expect(body).toEqual({ minClientVersion: '1.2.8' });
    expect(document.body.textContent).toContain(m.admin_platform_calls_mode_label());
  });

  // A save after a FAILED load used to send the whole form - its placeholders included: calls `off`
  // and a floor of `0.0.0` written over whatever the server held.
  it('refuses to save when nothing was loaded, and sends nothing', async () => {
    apiFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/announcement')
          ? new Response(JSON.stringify({ announcement: null }), { status: 200 })
          : new Response('down', { status: 500 })
      )
    );
    await render();
    await submitWith('1.2.8');

    expect(patchCalls()).toHaveLength(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      m.admin_platform_save_needs_load()
    );
  });

  it('diffs the next save against the server answer, not the first load', async () => {
    route(
      () => new Response(JSON.stringify({ ...CONFIG, minClientVersion: '1.2.8' }), { status: 200 })
    );
    await render();
    await submitWith('1.2.8');
    await submitWith('1.2.8');

    expect(patchCalls()).toHaveLength(2);
    expect(JSON.parse((patchCalls()[1][1] as { body: string }).body)).toEqual({});
  });

  it('sends a non-admin away before any request is made', async () => {
    admin.value = false;
    route(() => new Response('{}', { status: 200 }));
    await render();

    expect(goto).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
