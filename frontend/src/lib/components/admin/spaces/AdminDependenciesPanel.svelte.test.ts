// @vitest-environment happy-dom
/**
 * THE DEPENDENCIES PANEL (reform 2.7, WP-D1): each BDE with what depends on it, the rest apart, the
 * mismatches beside their entity; a parent change goes through `setDependency` and the axis is read
 * back, and a typed refusal is worded by its code.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { DependencyEntity } from '$lib/associations/api';

const api = vi.hoisted(() => ({
  listDependencies: vi.fn(),
  setDependency: vi.fn(),
}));
vi.mock('$lib/associations/api', async (original) => ({
  ...(await original<typeof import('$lib/associations/api')>()),
  ...api,
}));

import Panel from './AdminDependenciesPanel.svelte';
import { SocialApiError } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

const e = (over: Partial<DependencyEntity> & { id: string; name: string }): DependencyEntity => ({
  slug: over.id,
  type: 'association',
  archived: false,
  parentAssociationId: null,
  displayParentAssociationId: null,
  governs: false,
  mismatches: [],
  ...over,
});

const AXIS: DependencyEntity[] = [
  e({ id: 'bde', name: 'BDE', governs: true }),
  e({ id: 'fsss', name: 'BDE FSSS', governs: true }),
  e({ id: 'bds', name: 'BDS' }),
  e({
    id: 'list',
    name: 'Liste Rouge',
    type: 'list',
    parentAssociationId: 'bde',
    displayParentAssociationId: 'bds',
    mismatches: ['reaches_outside_parent'],
  }),
  e({ id: 'old', name: 'Vieille Asso', parentAssociationId: 'bde', archived: true }),
  e({
    id: 'list2',
    name: 'Liste Bleue',
    type: 'list',
    parentAssociationId: 'bde',
    mismatches: ['reaches_outside_parent'],
  }),
  e({ id: 'fine', name: 'Asso Fine', parentAssociationId: 'bde' }),
  e({ id: 'school', name: 'Ecole', type: 'institution', governs: true }),
];

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('40rem'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  api.listDependencies.mockResolvedValue(AXIS);
});

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Panel, { target, props: {} });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() => expect(target.querySelector('[data-family="bde"]')).not.toBeNull());
  return target;
}

async function pick(target: HTMLElement, triggerId: string, label: string) {
  target.querySelector<HTMLButtonElement>(`#${triggerId}`)!.click();
  flushSync();
  await tick();
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    .find((o) => o.textContent!.trim() === label)!
    .click();
  flushSync();
}

function button(target: HTMLElement, text: string) {
  return Array.from(target.querySelectorAll('button')).find((b) => b.textContent!.trim() === text)!;
}

it('puts each child under its BDE, with its label and its mismatch, and the rest apart', async () => {
  const target = await render();
  const family = target.querySelector('[data-family="bde"]')!;
  expect(family.querySelector('[data-dependency-row="list"]')).not.toBeNull();
  expect(family.textContent).toContain(m.admin_dependencies_shown_under({ name: 'BDS' }));
  expect(family.querySelector('[data-mismatch="reaches_outside_parent"]')).not.toBeNull();
  expect(target.querySelector('[data-family="school"]')).toBeNull();
  expect(target.textContent).toContain(m.admin_dependencies_institutions());
  expect(target.textContent).toContain(m.admin_dependencies_unattached());
});

it('moves a list to another BDE through setDependency, then reads the axis back', async () => {
  api.setDependency.mockResolvedValue(undefined);
  const target = await render();
  target.querySelector('[data-dependency-row="list"]')!.querySelector('button')!.click();
  flushSync();

  await pick(target, 'dependency-parent-list', 'BDE FSSS');
  button(target, m.common_save_button()).click();

  await vi.waitFor(() => expect(api.setDependency).toHaveBeenCalledWith('list', 'fsss', 'bds'));
  await vi.waitFor(() => expect(api.listDependencies).toHaveBeenCalledTimes(2));
});

it('words a refusal by its code', async () => {
  api.setDependency.mockRejectedValue(
    new SocialApiError('english', 'DEPENDENCY_PARENT_NOT_A_BDE', 409)
  );
  const target = await render();
  target.querySelector('[data-dependency-row="list"]')!.querySelector('button')!.click();
  flushSync();
  button(target, m.common_save_button()).click();

  await vi.waitFor(() =>
    expect(target.querySelector('[role="alert"]')!.textContent).toBe(
      m.dependency_err_parent_not_a_bde()
    )
  );
});

it('shows the audience warning as a labelled icon per row, never as a repeated sentence', async () => {
  const target = await render();
  const row = target.querySelector('[data-dependency-row="list"]')!;
  const icon = row.querySelector('[data-mismatch="reaches_outside_parent"]')!;
  expect(icon.getAttribute('aria-label')).toBe(m.dependency_mismatch_reaches_outside_parent());
  expect(icon.getAttribute('title')).toBe(m.dependency_mismatch_reaches_outside_parent());
  expect(row.textContent).not.toContain(m.dependency_mismatch_reaches_outside_parent());
});

it('summarises the warnings per BDE and filters the list to them', async () => {
  const target = await render();
  const family = target.querySelector('[data-family="bde"]')!;
  expect(family.querySelector('[data-mismatch-summary]')!.textContent).toContain(
    m.admin_dependencies_mismatch_summary_other({ count: 2 })
  );
  expect(target.querySelector('[data-mismatch-summary="fsss"]')).toBeNull();
  expect(family.querySelectorAll('[data-dependency-row]')).toHaveLength(4);

  family.querySelector<HTMLButtonElement>('[data-mismatch-filter]')!.click();
  flushSync();
  const ids = Array.from(family.querySelectorAll('[data-dependency-row]')).map((r) =>
    r.getAttribute('data-dependency-row')
  );
  expect(ids.sort()).toEqual(['list', 'list2']);

  family.querySelector<HTMLButtonElement>('[data-mismatch-filter]')!.click();
  flushSync();
  expect(family.querySelectorAll('[data-dependency-row]')).toHaveLength(4);
});

it('splits a BDE family into associations and lists, with a type chip per row', async () => {
  const target = await render();
  const family = target.querySelector('[data-family="bde"]')!;
  const lists = family.querySelector('[data-subgroup="list"]')!;
  const assos = family.querySelector('[data-subgroup="association"]')!;
  expect(lists.querySelectorAll('[data-dependency-row]')).toHaveLength(2);
  expect(assos.querySelectorAll('[data-dependency-row]')).toHaveLength(2);
  expect(lists.querySelector('[data-kind="list"]')!.textContent!.trim()).toBe(
    m.admin_dependencies_kind_list()
  );
});

it('says why a name is greyed: the entity is archived', async () => {
  const target = await render();
  const old = target.querySelector('[data-dependency-row="old"]')!;
  expect(old.querySelector('[data-archived-hint]')!.textContent!.trim()).toBe(
    m.admin_dependencies_archived()
  );
  expect(target.querySelector('[data-dependency-row="fine"] [data-archived-hint]')).toBeNull();
});
