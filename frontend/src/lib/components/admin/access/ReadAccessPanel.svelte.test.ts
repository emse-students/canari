/**
 * THE NAMED READERS SAVE AT ONCE, AND UNDO IS THE INVERSE WRITE (user, 2026-10-16).
 *
 * A box in the sheet writes its cell the moment it changes and the toast that follows carries
 * "Undo", which writes the opposite state - there is no undo endpoint. The journal under the list
 * is folded, and its summary carries the count.
 */
import { it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  listReadGrants: vi.fn(),
  setReadGrant: vi.fn(),
}));
vi.mock('$lib/associations/api', () => api);
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `Name ${id}`,
  resolveUserDisplayName: async () => null,
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));

import ReadAccessPanel from './ReadAccessPanel.svelte';
import { toastStore, dismissToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  for (const t of toastStore.toasts) dismissToast(t.id);
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const GRANT = {
  userId: 'u1',
  campus: 'gardanne',
  formation: null,
  grantedBy: 'admin',
  createdAt: '2026-10-16T10:00:00Z',
};
const JOURNAL = [
  {
    userId: 'u1',
    campus: 'gardanne',
    formation: null,
    action: 'grant',
    actor: 'admin',
    at: '2026-10-16T10:00:00Z',
  },
];

beforeEach(() => {
  api.listReadGrants.mockResolvedValue({ grants: [GRANT], journal: JOURNAL });
  api.setReadGrant.mockResolvedValue(undefined);
});

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(ReadAccessPanel, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="read-grant-card"]')).not.toBeNull()
  );
  return target;
}

it('folds the journal under the list, with its count in the summary', async () => {
  const target = await render();
  const journal = target.querySelector<HTMLDetailsElement>('[data-testid="access-journal"]')!;
  expect(journal.open).toBe(false);
  expect(journal.querySelector('summary')!.textContent!.trim()).toBe(
    m.readaccess_journal_summary({ count: 1 })
  );
});

it('a box in the sheet saves at once, and the toast undoes it with the inverse write', async () => {
  const target = await render();
  target.querySelector<HTMLButtonElement>('[data-testid="read-grant-card"] button')!.click();
  flushSync();
  const box = document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|ICM"]')!;
  expect(box.checked).toBe(false);

  box.click();
  await vi.waitFor(() =>
    expect(api.setReadGrant).toHaveBeenCalledWith('u1', 'gardanne', 'ICM', true)
  );
  // Re-read after the write: the server is the truth.
  await vi.waitFor(() => expect(api.listReadGrants).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(toastStore.toasts).toHaveLength(1));
  const toast = toastStore.toasts[0];
  expect(toast.message).toBe(
    m.readaccess_granted_toast({
      name: 'Name u1',
      campus: m.profile_campus_gardanne(),
      scope: 'ICM',
    })
  );
  expect(toast.action?.label).toBe(m.common_undo_label());

  toast.action!.run();
  await vi.waitFor(() =>
    expect(api.setReadGrant).toHaveBeenLastCalledWith('u1', 'gardanne', 'ICM', false)
  );
  // The undo is not itself offered for undoing.
  await vi.waitFor(() => expect(api.listReadGrants).toHaveBeenCalledTimes(3));
  expect(toastStore.toasts).toHaveLength(1);
});

it('a failed save puts the box back and says so', async () => {
  api.setReadGrant.mockRejectedValueOnce(new Error('boom'));
  const target = await render();
  target.querySelector<HTMLButtonElement>('[data-testid="read-grant-card"] button')!.click();
  flushSync();
  const box = document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|*"]')!;
  expect(box.checked).toBe(true);
  box.click();
  await vi.waitFor(() =>
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(m.readaccess_save_error())
  );
  expect(box.checked).toBe(true);
  expect(toastStore.toasts).toHaveLength(0);
});
