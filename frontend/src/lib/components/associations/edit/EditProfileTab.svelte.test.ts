// @vitest-environment happy-dom
/**
 * A LIST'S PARENT IS THE PLATFORM ADMIN'S (2026-11-02, `UPDATE_FIELD_RIGHTS.parentAssociationId`).
 * The profile form draws the parent picker for that reader alone, and a profile editor's save never
 * carries the field - the server would refuse the whole body for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Association } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  updateAssociation: vi.fn(),
  listAssociations: vi.fn(),
  listAssociationCategories: vi.fn(),
}));
vi.mock('$lib/associations/api', async (original) => ({
  ...(await original<typeof import('$lib/associations/api')>()),
  ...api,
}));

import EditProfileTab from './EditProfileTab.svelte';

const PARENT = '00000000-0000-4000-8000-0000000000bb';
const list = {
  id: '00000000-0000-4000-8000-0000000000aa',
  slug: 'liste',
  name: 'Liste',
  type: 'list',
  parentAssociationId: PARENT,
  promo: 2027,
} as unknown as Association;

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function render(canEditParent: boolean) {
  api.updateAssociation.mockResolvedValue(list);
  api.listAssociations.mockResolvedValue([]);
  api.listAssociationCategories.mockResolvedValue([]);
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(EditProfileTab, {
    target,
    props: { asso: list, canEdit: true, canEditParent, onUpdated: vi.fn() },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

async function save(target: HTMLElement) {
  const button = [...target.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.asso_edit_save_profile_button()
  )!;
  button.click();
  await vi.waitFor(() => expect(api.updateAssociation).toHaveBeenCalledOnce());
  return api.updateAssociation.mock.calls[0][1] as Record<string, unknown>;
}

describe('the list parent picker', () => {
  it('is hidden from a profile editor, whose save never sends the parent', async () => {
    const target = render(false);
    expect(target.querySelector('#edit-list-parent')).toBeNull();
    expect(api.listAssociations).not.toHaveBeenCalled();
    const payload = await save(target);
    expect(payload).not.toHaveProperty('parentAssociationId');
    expect(payload).toMatchObject({ name: 'Liste', promo: 2027 });
  });

  it('is drawn for the platform admin, whose save sends it', async () => {
    const target = render(true);
    expect(target.querySelector('#edit-list-parent')).not.toBeNull();
    const payload = await save(target);
    expect(payload).toMatchObject({ parentAssociationId: PARENT });
  });
});
