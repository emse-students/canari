// @vitest-environment happy-dom
/**
 * WHO SEES WHICH LIST: a global admin gets both tabs, a BDE super-admin the reviewers alone with no
 * tab bar - the named readers are a global admin's (D24), and their endpoint refuses anyone else.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const roles = vi.hoisted(() => ({ global: false, superAdmin: false }));
const api = vi.hoisted(() => ({
  ensureAssociationSuperAdmin: vi.fn(async () => {}),
  listReadGrants: vi.fn(async () => ({ grants: [], journal: [] })),
  setReadGrant: vi.fn(),
  listDocumentReviewers: vi.fn(async () => []),
  addDocumentReviewer: vi.fn(),
  removeDocumentReviewer: vi.fn(),
}));
const goto = vi.hoisted(() => vi.fn());

vi.mock('$lib/associations/api', () => api);
vi.mock('$lib/stores/user', () => ({
  isGlobalAdmin: () => roles.global,
  isAssociationSuperAdmin: () => roles.superAdmin,
}));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$app/state', () => ({
  page: { url: new URL('https://canari.test/admin/read-access'), state: {} },
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: async () => null,
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));

import Page from './+page.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() =>
    expect(
      target.querySelector('#add-reviewer-autocomplete, #add-read-grantee-autocomplete')
    ).not.toBeNull()
  );
  return target;
}

it('a global admin gets the two tabs, the named readers first', async () => {
  roles.global = true;
  roles.superAdmin = false;
  const target = await render();
  expect(target.querySelectorAll('[role="tab"]')).toHaveLength(2);
  expect(target.querySelector('#add-read-grantee-autocomplete')).not.toBeNull();
  expect(api.listReadGrants).toHaveBeenCalled();
});

it('a BDE super-admin gets the reviewers alone, no tab bar, and the readers are never asked for', async () => {
  roles.global = false;
  roles.superAdmin = true;
  const target = await render();
  expect(target.querySelector('[role="tablist"]')).toBeNull();
  expect(target.querySelector('#add-reviewer-autocomplete')).not.toBeNull();
  expect(target.querySelector('#add-read-grantee-autocomplete')).toBeNull();
  expect(api.listReadGrants).not.toHaveBeenCalled();
});

it('anyone else is sent back to the hub', async () => {
  roles.global = false;
  roles.superAdmin = false;
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() => expect(goto).toHaveBeenCalled());
  expect(target.querySelector('section')).toBeNull();
});
