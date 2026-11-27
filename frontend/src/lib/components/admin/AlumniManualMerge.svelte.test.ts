// @vitest-environment happy-dom
/**
 * "RATTACHER À UN AUTRE COMPTE" (D55): the admin searches the targets the server calls eligible, picks
 * one and writes why. The button stays disabled until the reason, trimmed, holds 20 to 1000
 * characters - the server's bounds - and the choice is handed to the page, trimmed, never marked here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));

import AlumniManualMerge from './AlumniManualMerge.svelte';
import { m } from '$lib/paraglide/messages';
import type { AlumniAccount } from '$lib/profile/alumniMerge';

const DUP: AlumniAccount = {
  uuid: '11111111-1111-4111-8111-111111111111',
  username: 'alumni-0001',
  name: 'Camille Durand',
  email: 'camille@alumni.test',
  lastLogin: null,
  promos: [2020],
  canariUserId: null,
};
const TARGET: AlumniAccount = {
  ...DUP,
  uuid: '22222222-2222-4222-8222-222222222222',
  username: 'c.martin',
  name: 'Camille MARTIN',
};

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = '';
  apiFetch.mockReset();
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

function open() {
  const onSubmit = vi.fn();
  mounted.push(
    mount(AlumniManualMerge, { target: document.body, props: { duplicate: DUP, onSubmit } })
  );
  flushSync();
  return onSubmit;
}

async function search(query: string) {
  const input = document.querySelector<HTMLInputElement>('input')!;
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  document
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

function type(reason: string) {
  const area = document.querySelector<HTMLTextAreaElement>('textarea')!;
  area.value = reason;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

const submit = () => document.querySelector<HTMLButtonElement>('[data-alumni-manual-submit]');
const counter = () => document.querySelector('[data-alumni-manual-counter]')?.textContent?.trim();

describe('AlumniManualMerge', () => {
  it('searches the eligible targets of this duplicate, and says when none matches', async () => {
    open();
    apiFetch.mockResolvedValue(new Response('[]', { status: 200 }));
    await search('Martin');
    expect(apiFetch).toHaveBeenCalledWith(
      `https://core.test/api/users/admin/alumni-duplicates/${DUP.uuid}/targets?q=Martin`
    );
    expect(document.querySelector('[data-alumni-manual-empty]')?.textContent?.trim()).toBe(
      m.admin_alumni_manual_no_result()
    );
    expect(submit()).toBeNull();
  });

  it('keeps the button disabled until the reason holds 20 to 1000 characters, then hands it trimmed', async () => {
    const onSubmit = open();
    apiFetch.mockResolvedValue(new Response(JSON.stringify([TARGET]), { status: 200 }));
    await search('Martin');
    document.querySelector<HTMLButtonElement>('[role="option"]')!.click();
    flushSync();

    expect(submit()?.disabled).toBe(true);
    type('   too short   ');
    expect(submit()?.disabled).toBe(true);
    expect(counter()).toBe(m.admin_alumni_manual_reason_too_short({ length: 9, min: 20 }));

    type('x'.repeat(1001));
    expect(submit()?.disabled).toBe(true);
    expect(counter()).toBe(m.admin_alumni_manual_reason_too_long({ length: 1001, max: 1000 }));

    const reason = 'Same person: married name, confirmed by e-mail.';
    type(`  ${reason}  `);
    expect(submit()?.disabled).toBe(false);
    expect(counter()).toBe(
      m.admin_alumni_manual_reason_count({ length: reason.length, max: 1000 })
    );
    submit()!.click();
    expect(onSubmit).toHaveBeenCalledWith(TARGET, reason);
  });

  it('does not search under two characters', async () => {
    open();
    await search('C');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
