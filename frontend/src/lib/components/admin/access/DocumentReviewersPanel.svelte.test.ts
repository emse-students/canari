// @vitest-environment happy-dom
/**
 * REMOVING A DOCUMENT REVIEWER ASKS FIRST, THEN OFFERS UNDO (user, 2026-10-16).
 *
 * The remove button is named, a refusal of the confirmation writes nothing, and the undo after a
 * removal re-grants (there is no undo endpoint). The journal is the grants in force and says it
 * cannot show a removal.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  listDocumentReviewers: vi.fn(),
  addDocumentReviewer: vi.fn(),
  removeDocumentReviewer: vi.fn(),
}));
vi.mock('$lib/associations/api', () => api);
const showConfirm = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm }));
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

import DocumentReviewersPanel from './DocumentReviewersPanel.svelte';
import { toastStore, dismissToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { addForm, pickUser } from '../../../../test/pickUser';

const ROW = { userId: 'r1', grantedBy: 'admin', createdAt: '2026-10-01T09:00:00Z' };

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  for (const t of toastStore.toasts) dismissToast(t.id);
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

beforeEach(() => {
  api.listDocumentReviewers.mockResolvedValue([ROW]);
  api.removeDocumentReviewer.mockResolvedValue({ ok: true });
  api.addDocumentReviewer.mockResolvedValue({ ...ROW, createdAt: '2026-10-16T09:00:00Z' });
});

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(DocumentReviewersPanel, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() =>
    expect(target.querySelector('[data-testid="reviewer-card"]')).not.toBeNull()
  );
  return target;
}

const removeButton = (target: HTMLElement) =>
  target.querySelector<HTMLButtonElement>('[data-testid="reviewer-card"] button')!;

it('the remove button is named, and a refused confirmation writes nothing', async () => {
  showConfirm.mockResolvedValue(false);
  const target = await render();
  expect(removeButton(target).getAttribute('aria-label')).toBe(
    m.docreview_revoke_aria({ name: 'Name r1' })
  );
  expect(removeButton(target).textContent!.trim()).toBe(m.docreview_revoke_button());

  removeButton(target).click();
  await vi.waitFor(() => expect(showConfirm).toHaveBeenCalledOnce());
  expect(showConfirm.mock.calls[0][0]).toBe(m.docreview_revoke_confirm({ name: 'Name r1' }));
  expect(api.removeDocumentReviewer).not.toHaveBeenCalled();
  expect(target.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(1);
});

it('a confirmed removal drops the card, and its undo grants again', async () => {
  showConfirm.mockResolvedValue(true);
  const target = await render();
  removeButton(target).click();
  await vi.waitFor(() => expect(api.removeDocumentReviewer).toHaveBeenCalledWith('r1'));
  await vi.waitFor(() =>
    expect(target.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(0)
  );
  await vi.waitFor(() => expect(toastStore.toasts).toHaveLength(1));
  expect(toastStore.toasts[0].message).toBe(m.docreview_removed_toast({ name: 'Name r1' }));

  toastStore.toasts[0].action!.run();
  await vi.waitFor(() => expect(api.addDocumentReviewer).toHaveBeenCalledWith('r1'));
  await vi.waitFor(() =>
    expect(target.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(1)
  );
});

it('the list of grants in force is folded, labelled as such and says a removal is not kept', async () => {
  const target = await render();
  const journal = target.querySelector<HTMLDetailsElement>('[data-testid="access-journal"]')!;
  expect(journal.open).toBe(false);
  expect(journal.querySelector('summary')!.textContent!.trim()).toBe(
    m.docreview_current_summary({ count: 1 })
  );
  expect(journal.textContent).toContain(
    m.docreview_journal_grant({ actor: 'Name admin', name: 'Name r1' })
  );
  expect(journal.textContent).toContain(m.docreview_journal_note());
});

it('a failed add keeps the person picked and says so; the field clears only on success', async () => {
  const target = await render();
  const FIELD = 'add-reviewer-autocomplete';
  await pickUser(FIELD, 'Ri');
  expect(addForm(FIELD).input.value).toBe('Rita');

  api.addDocumentReviewer.mockRejectedValueOnce(new Error('boom'));
  addForm(FIELD).submit();
  await vi.waitFor(() =>
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(m.common_generic_error_label())
  );
  expect(api.addDocumentReviewer).toHaveBeenCalledWith('r2');
  // Still picked: trying again is one press, with no search to redo.
  expect(addForm(FIELD).input.value).toBe('Rita');
  expect(toastStore.toasts).toHaveLength(0);

  api.addDocumentReviewer.mockResolvedValueOnce({
    userId: 'r2',
    grantedBy: 'admin',
    createdAt: '2026-10-16T09:00:00Z',
  });
  addForm(FIELD).submit();
  await vi.waitFor(() => expect(api.addDocumentReviewer).toHaveBeenCalledTimes(2));
  expect(api.addDocumentReviewer).toHaveBeenLastCalledWith('r2');
  await vi.waitFor(() => expect(addForm(FIELD).input.value).toBe(''));
  expect(target.querySelector('[role="alert"]')).toBeNull();
  expect(target.querySelectorAll('[data-testid="reviewer-card"]')).toHaveLength(2);
});
