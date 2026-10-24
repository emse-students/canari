// @vitest-environment happy-dom
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
  // The person search: one candidate, Rita.
  apiFetch: vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify([{ id: 'r2', displayName: 'Rita' }]), { status: 200 })
    )
  ),
}));

import ReadAccessPanel from './ReadAccessPanel.svelte';
import { toastStore, dismissToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';
import { addForm, pickUser } from '../../../../test/pickUser';

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

it('a failed save puts the box back and says so INSIDE the sheet, not on the page behind', async () => {
  api.setReadGrant.mockRejectedValueOnce(new Error('boom'));
  const target = await render();
  target.querySelector<HTMLButtonElement>('[data-testid="read-grant-card"] button')!.click();
  flushSync();
  const box = document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|*"]')!;
  expect(box.checked).toBe(true);
  box.click();
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="read-grant-sheet"] [role="alert"]')?.textContent
    ).toBe(m.readaccess_save_error())
  );
  expect(target.querySelector('[role="alert"]')).toBeNull();
  expect(box.checked).toBe(true);
  expect(toastStore.toasts).toHaveLength(0);
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const cell = (formation: string | null) => ({ ...GRANT, formation });
type Listing = { grants: unknown[]; journal: unknown[] };

it('an older re-read landing after a newer one is dropped: B stays ticked, the next click is no revoke', async () => {
  const target = await render();
  target.querySelector<HTMLButtonElement>('[data-testid="read-grant-card"] button')!.click();
  flushSync();
  // A's re-read is answered LAST, with the server as it was before B was written.
  const afterA = deferred<Listing>();
  const afterB = deferred<Listing>();
  api.listReadGrants.mockReturnValueOnce(afterA.promise).mockReturnValueOnce(afterB.promise);

  const boxA = () =>
    document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|ICM"]')!;
  const boxB = () =>
    document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|PDIS"]')!;
  boxA().click();
  await vi.waitFor(() => expect(api.listReadGrants).toHaveBeenCalledTimes(2));
  boxB().click();
  await vi.waitFor(() => expect(api.listReadGrants).toHaveBeenCalledTimes(3));

  afterB.resolve({ grants: [GRANT, cell('ICM'), cell('PDIS')], journal: JOURNAL });
  await vi.waitFor(() => expect(boxB().getAttribute('aria-busy')).toBe('false'));
  afterA.resolve({ grants: [GRANT, cell('ICM')], journal: JOURNAL });
  await vi.waitFor(() => expect(boxA().getAttribute('aria-busy')).toBe('false'));
  flushSync();

  expect(boxA().checked).toBe(true);
  expect(boxB().checked).toBe(true);
  const chips = [...target.querySelectorAll('[data-testid="read-grant-chip"]')].map((c) =>
    c.textContent!.trim()
  );
  expect(chips).toContain('PDIS');

  // The next click on B is a revoke only because B IS held.
  boxB().click();
  await vi.waitFor(() =>
    expect(api.setReadGrant).toHaveBeenLastCalledWith('u1', 'gardanne', 'PDIS', false)
  );
});

it('a box still saving is marked busy, and a click on it is put back', async () => {
  const target = await render();
  target.querySelector<HTMLButtonElement>('[data-testid="read-grant-card"] button')!.click();
  flushSync();
  const write = deferred<void>();
  api.setReadGrant.mockReturnValueOnce(write.promise);
  const box = document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|ICM"]')!;
  box.click();
  flushSync();
  expect(box.getAttribute('aria-busy')).toBe('true');
  expect(box.getAttribute('aria-disabled')).toBe('true');
  expect(box.disabled).toBe(false);
  box.click();
  flushSync();
  expect(box.checked).toBe(true);
  expect(api.setReadGrant).toHaveBeenCalledTimes(1);
  write.resolve();
  await vi.waitFor(() => expect(box.getAttribute('aria-busy')).toBe('false'));
});

it('the last change is undoable from inside the sheet, where the focus trap keeps a keyboard', async () => {
  const target = await render();
  target.querySelector<HTMLButtonElement>('[data-testid="read-grant-card"] button')!.click();
  flushSync();
  document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|ICM"]')!.click();
  const row = await vi.waitFor(() => {
    const el = document.querySelector('[data-testid="read-grant-last-change"]');
    expect(el).not.toBeNull();
    return el!;
  });
  expect(row.closest('[role="dialog"]')).not.toBeNull();
  const undo = row.querySelector('button')!;
  expect(undo.textContent!.trim()).toBe(m.common_undo_label());
  undo.click();
  await vi.waitFor(() =>
    expect(api.setReadGrant).toHaveBeenLastCalledWith('u1', 'gardanne', 'ICM', false)
  );
  flushSync();
  expect(document.querySelector('[data-testid="read-grant-last-change"]')).toBeNull();
});

it('a full journal page is counted as "200+", not as the whole history', async () => {
  api.listReadGrants.mockResolvedValue({
    grants: [GRANT],
    journal: Array.from({ length: 200 }, (_, i) => ({ ...JOURNAL[0], at: `2026-10-16T10:${i}` })),
  });
  const target = await render();
  expect(target.querySelector('[data-testid="access-journal"] summary')!.textContent!.trim()).toBe(
    m.readaccess_journal_summary({ count: '200+' })
  );
});

it('"Ajouter" opens the sheet for the person picked, and only then clears the field', async () => {
  await render();
  const FIELD = 'add-read-grantee-autocomplete';
  await pickUser(FIELD, 'Ri');
  expect(addForm(FIELD).input.value).toBe('Rita');
  addForm(FIELD).submit();
  await vi.waitFor(() =>
    expect(document.querySelector('input[data-cell="r2|gardanne|ICM"]')).not.toBeNull()
  );
  await vi.waitFor(() => expect(addForm(FIELD).input.value).toBe(''));
  expect(api.setReadGrant).not.toHaveBeenCalled();
});

it("a write landing after its sheet closed never puts its undo row in another person's sheet", async () => {
  const other = { ...GRANT, userId: 'u2' };
  api.listReadGrants.mockResolvedValue({ grants: [GRANT, other], journal: JOURNAL });
  const target = await render();
  await vi.waitFor(() =>
    expect(target.querySelectorAll('[data-testid="read-grant-card"]')).toHaveLength(2)
  );
  const edit = (i: number) =>
    target.querySelectorAll<HTMLButtonElement>('[data-testid="read-grant-card"] button')[i];

  edit(0).click();
  flushSync();
  const write = deferred<void>();
  api.setReadGrant.mockReturnValueOnce(write.promise);
  document.querySelector<HTMLInputElement>('input[data-cell="u1|gardanne|ICM"]')!.click();
  flushSync();
  // Close u1's sheet with the write still in flight, and open u2's.
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent!.trim() === m.readaccess_sheet_done())!
    .click();
  flushSync();
  edit(1).click();
  flushSync();
  await vi.waitFor(() =>
    expect(document.querySelector('input[data-cell="u2|gardanne|ICM"]')).not.toBeNull()
  );

  write.resolve();
  await vi.waitFor(() => expect(toastStore.toasts).toHaveLength(1));
  flushSync();
  // The toast still offers the undo; u2's sheet shows nothing of u1's change.
  expect(toastStore.toasts[0].message).toContain('Name u1');
  expect(document.querySelector('[data-testid="read-grant-last-change"]')).toBeNull();
});
