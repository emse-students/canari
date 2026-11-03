// @vitest-environment happy-dom
/**
 * A LIST'S PARENT IS THE PLATFORM ADMIN'S (2026-11-02, `UPDATE_FIELD_RIGHTS.parentAssociationId`).
 * The profile form draws the parent picker for that reader alone, and a profile editor's save never
 * carries the field - the server would refuse the whole body for it. Since WP-D1 the picker offers
 * the BDEs only (a governing parent), and the field is sent only when it changed: the server judges
 * and journals every parent write (`SpacesService.setParent`).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { Association } from '$lib/associations/api';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../../test/adoptTransitionAnimations';

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

afterAll(adoptTransitionAnimations());

const PARENT = '00000000-0000-4000-8000-0000000000bb';
const OTHER_BDE = '00000000-0000-4000-8000-0000000000cc';
const CANDIDATES = [
  { id: PARENT, name: 'BDE', type: 'association', isBDE: true, archived: false },
  { id: OTHER_BDE, name: 'BDE FSSS', type: 'association', isBDE: true, archived: false },
  { id: 'dd', name: 'BDS', type: 'association', isBDE: false, archived: false },
] as unknown as Association[];
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
  api.listAssociations.mockResolvedValue(CANDIDATES);
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

  it('is drawn for the platform admin, whose unchanged parent is not sent', async () => {
    const target = render(true);
    expect(target.querySelector('#edit-list-parent')).not.toBeNull();
    const payload = await save(target);
    expect(payload).not.toHaveProperty('parentAssociationId');
  });

  it('offers the BDEs only, and sends a changed parent', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('40rem'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const target = render(true);
    await vi.waitFor(() => expect(api.listAssociations).toHaveBeenCalled());
    await tick();
    target.querySelector<HTMLButtonElement>('#edit-list-parent')!.click();
    flushSync();
    await tick();
    const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const labels = options.map((o) => o.textContent!.trim());
    expect(labels).toContain('BDE FSSS');
    expect(labels).not.toContain('BDS');
    options.find((o) => o.textContent!.trim() === 'BDE FSSS')!.click();
    flushSync();

    const payload = await save(target);
    expect(payload).toMatchObject({ parentAssociationId: OTHER_BDE });
    vi.unstubAllGlobals();
  });
});
