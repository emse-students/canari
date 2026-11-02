// @vitest-environment happy-dom
/**
 * THE PLATFORM ADMIN'S CREATE FORM (owner, 2026-11-02): a name, a kind, its spaces, an OPTIONAL
 * first admin - and nobody at all by default. The slug preview is the server's answer, never a
 * client derivation, and an answer older than the one on screen is dropped.
 */
import { it, expect, afterEach, afterAll, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  adminCreateAssociation: vi.fn(),
  previewAdminSlug: vi.fn(),
}));
vi.mock('$lib/associations/api', async (original) => ({
  ...(await original<typeof import('$lib/associations/api')>()),
  ...api,
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
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

import AdminEntityCreateForm from './AdminEntityCreateForm.svelte';
import { SocialApiError, ADMIN_ASSOCIATION_FIRST_ADMIN_UNKNOWN } from '$lib/associations/api';
import { firstAdminPresetFor } from '$lib/associations/editSections';
import { m } from '$lib/paraglide/messages';
import { pickUser } from '../../../../test/pickUser';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const onCreated = vi.fn();
  const instance = mount(AdminEntityCreateForm, { target, props: { onCreated } });
  mounted.push(() => unmount(instance));
  flushSync();
  return { target, onCreated };
}

function typeName(target: HTMLElement, value: string) {
  const input = target.querySelector<HTMLInputElement>('form input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const preview = (target: HTMLElement) =>
  target.querySelector('[data-slug-preview]')!.textContent!.trim();

async function submit(target: HTMLElement) {
  target.querySelector('form')!.requestSubmit();
  await tick();
}

it('previews the slug the SERVER answers, under the base of the kind', async () => {
  api.previewAdminSlug.mockResolvedValue('club-2');
  const { target } = render();
  typeName(target, '  Club  ');

  await vi.waitFor(() =>
    expect(preview(target)).toBe(m.admin_entity_slug_preview({ path: '/associations/club-2' }))
  );
  expect(api.previewAdminSlug).toHaveBeenCalledWith('Club');
});

it('drops a preview answer older than the one on screen', async () => {
  let releaseFirst: (slug: string) => void = () => undefined;
  api.previewAdminSlug
    .mockImplementationOnce(() => new Promise<string>((resolve) => (releaseFirst = resolve)))
    .mockResolvedValueOnce('club-photo');
  const { target } = render();
  typeName(target, 'Club');
  await vi.waitFor(() => expect(api.previewAdminSlug).toHaveBeenCalledTimes(1));
  typeName(target, 'Club Photo');
  await vi.waitFor(() =>
    expect(preview(target)).toBe(m.admin_entity_slug_preview({ path: '/associations/club-photo' }))
  );

  releaseFirst('club');
  await tick();
  expect(preview(target)).toBe(m.admin_entity_slug_preview({ path: '/associations/club-photo' }));
});

it('creates with NO member by default: no first admin is sent, and no space when none is ticked', async () => {
  api.adminCreateAssociation.mockResolvedValue({ id: 'a1', slug: 'club', name: 'Club' });
  const { target, onCreated } = render();
  typeName(target, 'Club');
  expect(target.querySelector('[data-first-admin-hint]')!.textContent!.trim()).toBe(
    m.admin_entity_first_admin_none()
  );

  await submit(target);

  await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(api.adminCreateAssociation).toHaveBeenCalledWith({
    name: 'Club',
    type: 'association',
    audiences: [],
  });
});

it('sends the spaces ticked as rules, and the picked first admin with the admin preset', async () => {
  api.adminCreateAssociation.mockResolvedValue({ id: 'a1', slug: 'club', name: 'Club' });
  const { target, onCreated } = render();
  typeName(target, 'Club');
  // The first box of the cell picker is a whole campus.
  target.querySelector<HTMLButtonElement>('[data-cell-picker] button')!.click();
  flushSync();
  await pickUser('admin-create-first-admin', 'Rit');
  await vi.waitFor(() =>
    expect(target.querySelector('[data-first-admin-hint]')!.textContent!.trim()).toBe(
      m.admin_entity_first_admin_set()
    )
  );

  await submit(target);

  await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
  const payload = api.adminCreateAssociation.mock.calls[0][0];
  expect(payload.audiences).toEqual([{ formation: null, campus: 'saint-etienne' }]);
  expect(payload.firstAdmin).toEqual({
    userId: 'r2',
    role: m.asso_members_role_admin(),
    permissions: firstAdminPresetFor('association'),
  });
});

it('a refused first admin is said by its code, and nothing is reported created', async () => {
  api.adminCreateAssociation.mockRejectedValue(
    new SocialApiError('gone', ADMIN_ASSOCIATION_FIRST_ADMIN_UNKNOWN, 400)
  );
  const { target, onCreated } = render();
  typeName(target, 'Club');

  await submit(target);

  await vi.waitFor(() =>
    expect(target.querySelector('[role="alert"]')!.textContent!.trim()).toBe(
      m.admin_entity_admin_unknown()
    )
  );
  expect(onCreated).not.toHaveBeenCalled();
});

it('a blank name is refused before any request', async () => {
  const { target } = render();
  // Spaces only: the field's `required` lets it through, the form's own check does not.
  typeName(target, '   ');
  await submit(target);
  expect(target.querySelector('[role="alert"]')!.textContent!.trim()).toBe(
    m.assoc_new_error_required()
  );
  expect(api.adminCreateAssociation).not.toHaveBeenCalled();
});
