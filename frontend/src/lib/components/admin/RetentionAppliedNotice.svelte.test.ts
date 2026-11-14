// @vitest-environment happy-dom
/**
 * THE RETENTION-APPLIED NOTICE ON /admin/platform (re-review of #3521, review of #3554): a notice to
 * media-service that was lost leaves it stamping the old durations, and the page SAYS so - "pas encore
 * appliqué aux fichiers" with "Renvoyer" - until media-service holds what was saved. What
 * media-service answered, what could not reach it, and a failure of the page's OWN request are said
 * apart; only the latest request's answer is shown.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

import Notice from './RetentionAppliedNotice.svelte';
import { m } from '$lib/paraglide/messages';

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = '';
  apiFetch.mockReset();
  vi.restoreAllMocks();
});

const answer = (state: string, refusal: object | null = null) =>
  Promise.resolve(new Response(JSON.stringify({ state, refusal }), { status: 200 }));

async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

async function open(revision = 1) {
  const props = $state({ revision });
  mounted.push(mount(Notice, { target: document.body, props }));
  await settle();
  return props;
}

const notice = () => document.querySelector<HTMLElement>('[data-retention-applied]');
const resendButton = () => notice()?.querySelector<HTMLButtonElement>('button') ?? null;

describe('RetentionAppliedNotice', () => {
  it('says nothing while media-service stamps the saved durations', async () => {
    apiFetch.mockImplementation(() => answer('applied'));
    await open();
    expect(notice()).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith(
      'https://core.test/api/users/admin/platform/retention-applied',
      undefined
    );
  });

  it('says "pas encore appliqué" while media-service is behind, and "Renvoyer" clears it once it re-reads', async () => {
    apiFetch.mockImplementationOnce(() => answer('behind'));
    await open();
    expect(notice()?.dataset.retentionApplied).toBe('behind');
    expect(notice()?.textContent).toContain(m.admin_platform_retention_not_applied());

    apiFetch.mockImplementationOnce(() => answer('applied'));
    resendButton()!.click();
    await settle();
    expect(apiFetch).toHaveBeenLastCalledWith(
      'https://core.test/api/users/admin/platform/retention-applied/resend',
      { method: 'POST' }
    );
    expect(notice()).toBeNull();
  });

  it('says it could not reach media-service, and keeps "Renvoyer" offered', async () => {
    apiFetch.mockImplementation(() => answer('unreachable'));
    await open();
    expect(notice()?.textContent).toContain(m.admin_platform_retention_media_unreachable());
    expect(resendButton()?.textContent).toContain(m.admin_platform_retention_resend());
  });

  it.each([
    ['secret', 401, () => m.admin_platform_retention_media_refused_secret({ status: 401 })],
    ['route', 404, () => m.admin_platform_retention_media_refused_route({ status: 404 })],
    ['malformed', 200, () => m.admin_platform_retention_media_refused_malformed()],
    ['status', 500, () => m.admin_platform_retention_media_refused_status({ status: 500 })],
  ])('words a refusal by media-service (%s) as the answer it is', async (reason, status, text) => {
    apiFetch.mockImplementation(() => answer('refused', { status, reason }));
    await open();
    expect(notice()?.dataset.retentionApplied).toBe('refused');
    expect(notice()?.textContent).toContain(text());
  });

  it("a failure of the page's OWN request claims nothing about media-service, and offers no resend", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiFetch.mockImplementation(() => Promise.resolve(new Response('{}', { status: 500 })));
    await open();
    expect(notice()?.dataset.retentionApplied).toBe('failed');
    expect(notice()?.textContent).toContain(m.admin_platform_retention_read_failed());
    expect(notice()?.textContent).not.toContain(m.admin_platform_retention_media_unreachable());
    expect(resendButton()).toBeNull();
  });

  it('an answer with no known state is a failed read, never shown as a state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ maintenanceEnabled: false }), { status: 200 }))
    );
    await open();
    expect(notice()?.dataset.retentionApplied).toBe('failed');
  });

  it('a failed "Renvoyer" raises the alert and keeps what was shown', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiFetch.mockImplementationOnce(() => answer('behind'));
    await open();
    apiFetch.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    resendButton()!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      m.admin_platform_retention_resend_error()
    );
    expect(notice()?.dataset.retentionApplied).toBe('behind');
  });

  it('a refused answer without its refusal is a failed read, never worded "HTTP 0"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiFetch.mockImplementation(() => answer('refused', null));
    await open();
    expect(notice()?.dataset.retentionApplied).toBe('failed');
    expect(notice()?.textContent).not.toContain('HTTP 0');
  });

  it('a newer read that FAILS leaves the older good answer shown, not a stale nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let slow!: (r: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>((r) => (slow = r)));
    const props = await open(1);
    apiFetch.mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 500 })));
    props.revision = 2;
    await settle();
    slow(new Response(JSON.stringify({ state: 'behind', refusal: null }), { status: 200 }));
    await settle();
    expect(notice()?.dataset.retentionApplied).toBe('behind');
  });

  it('after "Renvoyer", a read that started before the notice completed cannot replace its answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiFetch.mockImplementationOnce(() => answer('behind'));
    const props = await open(1);

    let resendDone!: (r: Response) => void;
    let staleRead!: (r: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>((r) => (resendDone = r)));
    resendButton()!.click();
    await settle();
    apiFetch.mockImplementationOnce(() => new Promise<Response>((r) => (staleRead = r)));
    props.revision = 2;
    await settle();

    resendDone(new Response(JSON.stringify({ state: 'applied', refusal: null }), { status: 200 }));
    await settle();
    expect(notice()).toBeNull();
    staleRead(new Response(JSON.stringify({ state: 'behind', refusal: null }), { status: 200 }));
    await settle();
    expect(notice()).toBeNull();
  });

  it("a later successful read clears a failed resend's alert", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiFetch.mockImplementationOnce(() => answer('behind'));
    const props = await open(1);
    apiFetch.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    resendButton()!.click();
    await settle();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    apiFetch.mockImplementationOnce(() => answer('behind'));
    props.revision = 2;
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('logs a state CHANGE, not every view', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiFetch.mockImplementation(() => answer('behind'));
    const props = await open(1);
    props.revision = 2;
    await settle();
    props.revision = 3;
    await settle();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('state behind'))).toHaveLength(1);
  });

  it('shows only the LATEST request: an older answer arriving late is dropped', async () => {
    let slow!: (r: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>((r) => (slow = r)));
    const props = await open(1);
    apiFetch.mockImplementationOnce(() => answer('applied'));
    props.revision = 2;
    await settle();
    expect(notice()).toBeNull();
    slow(new Response(JSON.stringify({ state: 'behind', refusal: null }), { status: 200 }));
    await settle();
    expect(notice()).toBeNull();
  });
});
