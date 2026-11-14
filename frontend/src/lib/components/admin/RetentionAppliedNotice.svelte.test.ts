// @vitest-environment happy-dom
/**
 * THE RETENTION-APPLIED NOTICE ON /admin/platform (re-review of #3521): a notice to media-service that
 * was lost leaves it stamping the old durations, and the page SAYS so - "pas encore appliqué aux
 * fichiers" with "Renvoyer" - until media-service holds what was saved. Nothing shows while it does.
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
});

const answer = (state: string) =>
  Promise.resolve(new Response(JSON.stringify({ state }), { status: 200 }));

async function settle() {
  for (let i = 0; i < 5; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

async function open() {
  mounted.push(mount(Notice, { target: document.body, props: { revision: 1 } }));
  await settle();
}

describe('RetentionAppliedNotice', () => {
  it('says nothing while media-service stamps the saved durations', async () => {
    apiFetch.mockImplementation(() => answer('applied'));
    await open();
    expect(document.querySelector('[data-retention-applied]')).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith(
      'https://core.test/api/users/admin/platform/retention-applied',
      undefined
    );
  });

  it('says "pas encore appliqué" while media-service is behind, and "Renvoyer" clears it once it re-reads', async () => {
    apiFetch.mockImplementationOnce(() => answer('behind'));
    await open();
    const notice = document.querySelector('[data-retention-applied="behind"]');
    expect(notice?.textContent).toContain(m.admin_platform_retention_not_applied());

    apiFetch.mockImplementationOnce(() => answer('applied'));
    document.querySelector<HTMLButtonElement>('[data-retention-applied] button')!.click();
    await settle();
    expect(apiFetch).toHaveBeenLastCalledWith(
      'https://core.test/api/users/admin/platform/retention-applied/resend',
      { method: 'POST' }
    );
    expect(document.querySelector('[data-retention-applied]')).toBeNull();
  });

  it('says it could not ask when media-service is unreachable, and keeps "Renvoyer" offered', async () => {
    apiFetch.mockImplementation(() => answer('unreachable'));
    await open();
    expect(document.querySelector('[data-retention-applied="unreachable"]')?.textContent).toContain(
      m.admin_platform_retention_media_unreachable()
    );
  });
});
