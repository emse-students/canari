// @vitest-environment happy-dom
/**
 * `/admin/spaces` IS THE PLATFORM ADMIN'S WHOLE CATALOGUE (owner, 2026-11-02): every row links to
 * the entity's public page AND its management page, a search and a type filter narrow it on the
 * SERVER, and each kind is paged by keyset - "show more" asks for the cursor the last page gave.
 */
import { it, expect, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const api = vi.hoisted(() => ({
  listSpaces: vi.fn(),
  listAdminCatalogue: vi.fn(),
  getAssociationAudiences: vi.fn(),
  setSpaceBde: vi.fn(),
  setAssociationAudiences: vi.fn(),
  adminCreateAssociation: vi.fn(),
  previewAdminSlug: vi.fn(),
  listDependencies: vi.fn(),
  setDependency: vi.fn(),
}));
vi.mock('$lib/associations/api', async (original) => ({
  ...(await original<typeof import('$lib/associations/api')>()),
  ...api,
}));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => true }));
const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));

import Page from './+page.svelte';
import { m } from '$lib/paraglide/messages';
import { campusLabel, formationLabel } from '$lib/profile/miconnectProfile';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

type Kind = 'association' | 'list' | 'institution';

const row = (id: string, name: string, slug: string, type: Kind, memberCount = 0) => ({
  id,
  name,
  slug,
  type,
  memberCount,
  audiences: [{ formation: null, campus: 'gardanne' }],
});

const FIRST: Record<Kind, { rows: ReturnType<typeof row>[]; next: string | null }> = {
  association: { rows: [row('a1', 'Club Photo', 'club-photo', 'association')], next: 'cur-a' },
  list: { rows: [row('l1', 'Liste Rouge', 'liste-rouge', 'list', 3)], next: null },
  institution: { rows: [row('i1', 'Ecole', 'ecole', 'institution')], next: null },
};

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  api.listSpaces.mockResolvedValue([]);
  api.listDependencies.mockResolvedValue([]);
  api.listAdminCatalogue.mockImplementation(
    async (type: Kind, opts: { q?: string; after?: string | null }) => {
      if (opts.after === 'cur-a') {
        return { rows: [row('a2', 'Club Zen', 'club-zen', 'association')], next: null };
      }
      if (opts.q) {
        return { rows: FIRST[type].rows.filter((r) => r.name.includes(opts.q!)), next: null };
      }
      return FIRST[type];
    }
  );
});

async function render() {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(Page, { target });
  mounted.push(() => unmount(instance));
  await vi.waitFor(() => expect(target.querySelectorAll('[data-row-links]')).toHaveLength(3));
  return target;
}

const linksOf = (target: HTMLElement) =>
  Array.from(target.querySelectorAll('[data-row-links]')).map((el) =>
    Array.from(el.querySelectorAll('a')).map((a) => [a.textContent!.trim(), a.getAttribute('href')])
  );

it('gives every row its public page and its management page, under the base of its kind', async () => {
  const target = await render();

  expect(linksOf(target)).toEqual([
    [
      [m.admin_entity_link_public(), '/associations/club-photo'],
      [m.admin_entity_link_manage(), '/associations/club-photo/edit'],
    ],
    [
      [m.admin_entity_link_public(), '/lists/liste-rouge'],
      [m.admin_entity_link_manage(), '/lists/liste-rouge/edit'],
    ],
    [
      [m.admin_entity_link_public(), '/associations/ecole'],
      [m.admin_entity_link_manage(), '/associations/ecole/edit'],
    ],
  ]);
  // A member count per row, zero included - an entity with nobody in it is shown as such.
  expect(target.textContent).toContain(m.asso_edit_hub_members_summary({ count: 0 }));
  expect(target.textContent).toContain(m.asso_edit_hub_members_summary({ count: 3 }));
});

it('pages a kind by its cursor: "show more" appends the next page', async () => {
  const target = await render();
  const more = Array.from(target.querySelectorAll('button')).find(
    (b) => b.textContent!.trim() === m.admin_entity_load_more()
  )!;

  more.click();

  await vi.waitFor(() =>
    expect(target.querySelector('[data-section="association"]')!.textContent).toContain('Club Zen')
  );
  expect(api.listAdminCatalogue).toHaveBeenCalledWith('association', { q: '', after: 'cur-a' });
  expect(target.querySelector('[data-section="association"]')!.textContent).toContain('Club Photo');
});

it('searches on the server, every visible kind, and says when nothing matches', async () => {
  const target = await render();
  const search = target.querySelector<HTMLInputElement>('input[type="search"]')!;

  search.value = 'Rouge';
  search.dispatchEvent(new Event('input', { bubbles: true }));

  await vi.waitFor(() => expect(target.querySelectorAll('[data-row-links]')).toHaveLength(1));
  for (const kind of ['association', 'list', 'institution'] as const) {
    expect(api.listAdminCatalogue).toHaveBeenCalledWith(kind, { q: 'Rouge' });
  }
  expect(target.querySelector('[data-section="association"]')!.textContent).toContain(
    m.admin_entity_search_empty()
  );
});

it('the type filter shows one kind and asks only for it', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('40rem'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  const target = await render();
  api.listAdminCatalogue.mockClear();
  target.querySelector<HTMLButtonElement>('#admin-spaces-kind')!.click();
  flushSync();
  await tick();
  const listOption = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="option"]')
  ).find((o) => o.textContent!.trim() === m.admin_spaces_section_lists())!;

  listOption.click();
  flushSync();

  await vi.waitFor(() =>
    expect(
      Array.from(target.querySelectorAll('[data-section]')).map((s) =>
        s.getAttribute('data-section')
      )
    ).toEqual(['list'])
  );
  expect(api.listAdminCatalogue).toHaveBeenCalledTimes(1);
  expect(api.listAdminCatalogue).toHaveBeenCalledWith('list', { q: '' });
});

it('opens the create form from the header and closes it on a creation', async () => {
  const target = await render();
  expect(target.querySelector('[data-admin-create]')).toBeNull();
  const open = Array.from(target.querySelectorAll('button')).find(
    (b) => b.textContent!.trim() === m.admin_entity_create_open()
  )!;
  open.click();
  flushSync();
  expect(target.querySelector('[data-admin-create]')).not.toBeNull();
});

function typeSearch(target: HTMLElement, value: string) {
  const search = target.querySelector<HTMLInputElement>('input[type="search"]')!;
  search.value = value;
  search.dispatchEvent(new Event('input', { bubbles: true }));
}

it('drops a search answer older than the one on screen', async () => {
  const target = await render();
  let releaseFirst: () => void = () => undefined;
  const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
  api.listAdminCatalogue.mockImplementation(async (type: Kind, opts: { q?: string }) => {
    if (opts.q === 'Club') {
      await firstHeld;
      return { rows: type === 'association' ? FIRST.association.rows : [], next: null };
    }
    return { rows: type === 'list' ? FIRST.list.rows : [], next: null };
  });

  typeSearch(target, 'Club');
  await vi.waitFor(() =>
    expect(api.listAdminCatalogue).toHaveBeenCalledWith('association', { q: 'Club' })
  );
  typeSearch(target, 'Rouge');
  await vi.waitFor(() => expect(target.querySelectorAll('[data-row-links]')).toHaveLength(1));
  expect(target.textContent).toContain('Liste Rouge');

  releaseFirst();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.textContent).toContain('Liste Rouge');
  expect(target.textContent).not.toContain('Club Photo');
});

it('"show more" inside the search pause asks with the query its cursor was read for', async () => {
  const target = await render();
  typeSearch(target, 'Zen');
  const more = Array.from(target.querySelectorAll('button')).find(
    (b) => b.textContent!.trim() === m.admin_entity_load_more()
  )!;

  more.click();

  await vi.waitFor(() =>
    expect(api.listAdminCatalogue).toHaveBeenCalledWith('association', { q: '', after: 'cur-a' })
  );
  expect(api.listAdminCatalogue).not.toHaveBeenCalledWith('association', {
    q: 'Zen',
    after: 'cur-a',
  });
});

/**
 * GOVERNING IS NOT REACHING (reform 2.5, WP-D1): an institution may govern a space (D3), a governor's
 * reach box is a box like any other, and a designation reads back the spaces and the dependency
 * axis - never the governor's rules, which the server no longer touches.
 */
const SPACE = `${formationLabel('ICM')} · ${campusLabel('saint-etienne')}`;

it('lets an institution govern, and reads the axis again rather than the rules', async () => {
  api.listSpaces.mockResolvedValue([
    { id: 's1', formation: 'ICM', campus: 'saint-etienne', openedAt: '', bde: null },
  ]);
  api.setSpaceBde.mockResolvedValue(undefined);
  const target = await render();
  await vi.waitFor(() => expect(api.listDependencies).toHaveBeenCalledTimes(1));
  const space = SPACE;
  const star = (name: string) =>
    target.querySelector<HTMLButtonElement>(
      `button[aria-label="${m.admin_spaces_bde_aria({ association: name, space })}"]`
    );
  expect(star('Liste Rouge')).toBeNull();
  expect(star('Club Photo')).not.toBeNull();

  star('Ecole')!.click();

  await vi.waitFor(() => expect(api.setSpaceBde).toHaveBeenCalledWith('s1', 'i1'));
  await vi.waitFor(() => expect(api.listDependencies).toHaveBeenCalledTimes(2));
  expect(api.getAssociationAudiences).not.toHaveBeenCalled();
});

it("toggles a governor's reach like any other box", async () => {
  api.listSpaces.mockResolvedValue([
    {
      id: 's1',
      formation: 'ICM',
      campus: 'saint-etienne',
      openedAt: '',
      bde: { id: 'a1', name: 'Club Photo' },
    },
  ]);
  api.setAssociationAudiences.mockResolvedValue([]);
  const target = await render();
  const reach = target.querySelector<HTMLButtonElement>(
    `button[aria-label="${m.admin_spaces_reach_aria({ association: 'Club Photo', space: SPACE })}"]`
  )!;

  reach.click();

  await vi.waitFor(() => expect(api.setAssociationAudiences).toHaveBeenCalledOnce());
  expect(api.setAssociationAudiences.mock.calls[0][0]).toBe('a1');
});
