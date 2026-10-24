// @vitest-environment happy-dom
/**
 * EACH DIRECTORY TAB OWNS ITS OWN "Mes ..." BLOCK (user, 2026-10-19). `/associations` shows only
 * "Mes associations", `/institutions` only "Mes institutions", `/lists` only "Mes listes"; a block
 * is not drawn when the reader has no row of that kind, and the directory below keeps listing every
 * row (the member's own one badged), as before.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const data = vi.hoisted(() => ({ mine: [] as unknown[], dir: {} as Record<string, unknown[]> }));

vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'u-1', isGlobalAdmin: () => false }));
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listMyAssociations: async () => data.mine,
  listAssociationDirectory: async (type: string) => data.dir[type] ?? [],
}));

import AssociationsPage from './+page.svelte';
import InstitutionsPage from '../institutions/+page.svelte';
import ListsPage from '../lists/+page.svelte';

const asso = (id: string, type: string, name: string) => ({
  id,
  slug: id,
  name,
  type,
  archived: false,
  description: '',
});
const A = asso('a1', 'association', 'Club Alpha');
const I = asso('i1', 'institution', 'Delegues Beta');
const L = asso('l1', 'list', 'Liste Gamma');

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function render(Page: typeof AssociationsPage) {
  const target = document.createElement('div');
  document.body.append(target);
  const cmp = mount(Page, { target });
  mounted.push(() => unmount(cmp));
  for (let i = 0; i < 5; i++) await tick();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
  return target;
}

const blockHeadings = (t: HTMLElement) =>
  [...t.querySelectorAll('[data-testid="my-memberships"] h2')].map((h) => h.textContent?.trim());
const count = (t: HTMLElement, name: string) =>
  (t.textContent?.match(new RegExp(name, 'g')) ?? []).length;

describe('the "Mes ..." blocks', () => {
  it('puts each kind on its own tab and nowhere else', async () => {
    data.mine = [A, I, L];
    data.dir = { association: [A], institution: [I], list: [L] };

    expect(blockHeadings(await render(AssociationsPage))).toEqual(['Mes associations']);
    expect(blockHeadings(await render(InstitutionsPage))).toEqual(['Mes institutions']);
    expect(blockHeadings(await render(ListsPage))).toEqual(['Mes listes']);
  });

  it('draws the pinned block and the directory, the directory keeping the member row once', async () => {
    data.mine = [I];
    data.dir = { institution: [I] };
    const t = await render(InstitutionsPage);
    // once in the pinned block, once in the directory - never twice in either
    expect(count(t, 'Delegues Beta')).toBe(2);
    expect(t.querySelectorAll('[data-testid="my-memberships"] a').length).toBe(1);
  });

  it('draws no block for a reader who belongs to none, and none for the other kinds', async () => {
    data.mine = [A];
    data.dir = { association: [A], institution: [I], list: [L] };
    expect(blockHeadings(await render(InstitutionsPage))).toEqual([]);
    expect(blockHeadings(await render(ListsPage))).toEqual([]);
    expect(blockHeadings(await render(AssociationsPage))).toEqual(['Mes associations']);
  });
});
