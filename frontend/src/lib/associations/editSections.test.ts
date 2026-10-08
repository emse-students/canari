/**
 * THE RIGHTS A SECTION IS GATED ON, and the path that makes Back go up exactly one level.
 *
 * The old edit page validated a requested section only against its static list, so a typed
 * `/edit/danger` (or `?section=`) opened a section its reader held no right for. A section is a
 * route segment now, which makes the segment user input: `mayOpenEditSection` is what refuses it.
 */
import { describe, it, expect } from 'vitest';
import { AssociationPermissionFlag } from '$lib/associations/api';
import {
  EDIT_SECTIONS,
  LIST_EDIT_SECTIONS,
  editRights,
  editSectionHref,
  editTrail,
  mayOpenEditSection,
  parseEditSection,
  visibleEditSections,
} from './editSections';
import { previousCrumb } from '$lib/components/navigation/breadcrumb';

const none = { isGlobalAdmin: false, isSuperAdmin: false, memberPermissions: 0 };
const withFlags = (...flags: AssociationPermissionFlag[]) => ({
  ...none,
  memberPermissions: flags.reduce((a, f) => a | f, 0),
});

describe('which sections a reader may open', () => {
  it('gives a member holding no right the profile alone', () => {
    expect(visibleEditSections(editRights(none))).toEqual(['profile']);
  });

  it('refuses every gated section to a member without its flag', () => {
    const rights = editRights(none);
    for (const s of EDIT_SECTIONS.filter((x) => x !== 'profile')) {
      expect(mayOpenEditSection(s, rights), s).toBe(false);
    }
  });

  it('opens a section on its own flag and no other', () => {
    const forms = editRights(withFlags(AssociationPermissionFlag.MANAGE_FORMS));
    expect(visibleEditSections(forms)).toEqual(['profile', 'formulaires']);
    const docs = editRights(withFlags(AssociationPermissionFlag.MANAGE_DOCUMENTS));
    expect(mayOpenEditSection('documents', docs)).toBe(true);
    expect(mayOpenEditSection('formulaires', docs)).toBe(false);
  });

  it('opens payments on the shop right, and cotisations on members OR shop', () => {
    const shop = editRights(withFlags(AssociationPermissionFlag.MANAGE_PRODUCTS));
    expect(mayOpenEditSection('payments', shop)).toBe(true);
    expect(mayOpenEditSection('cotisations', shop)).toBe(true);
    expect(mayOpenEditSection('members', shop)).toBe(false);
  });

  it('opens the proposal queue on either of its two flags', () => {
    expect(
      mayOpenEditSection(
        'republications',
        editRights(withFlags(AssociationPermissionFlag.PROPOSE_EVENT))
      )
    ).toBe(true);
    expect(
      mayOpenEditSection(
        'republications',
        editRights(withFlags(AssociationPermissionFlag.POST_AS_ASSO))
      )
    ).toBe(true);
  });

  it('gives danger to whoever may archive (members) and the audience to a global admin or BDE star', () => {
    expect(
      mayOpenEditSection('danger', editRights(withFlags(AssociationPermissionFlag.MANAGE_MEMBERS)))
    ).toBe(true);
    // An association's own admin never holds the audience, however many flags they have.
    const everyFlag = withFlags(
      ...(Object.values(AssociationPermissionFlag).filter(
        (v) => typeof v === 'number'
      ) as AssociationPermissionFlag[])
    );
    expect(mayOpenEditSection('audience', editRights(everyFlag))).toBe(false);
    expect(mayOpenEditSection('audience', editRights({ ...none, isGlobalAdmin: true }))).toBe(true);
    expect(mayOpenEditSection('audience', editRights({ ...none, isSuperAdmin: true }))).toBe(true);
  });

  it('keeps an institution audience to the global admin', () => {
    const star = editRights({ ...none, isSuperAdmin: true }, 'institution');
    expect(mayOpenEditSection('audience', star)).toBe(false);
    expect(
      mayOpenEditSection('audience', editRights({ ...none, isGlobalAdmin: true }, 'institution'))
    ).toBe(true);
  });

  it('gives a list three sections and refuses it the association-only ones', () => {
    const admin = editRights({ ...none, isGlobalAdmin: true }, 'list');
    expect(visibleEditSections(admin, LIST_EDIT_SECTIONS)).toEqual([
      'profile',
      'members',
      'danger',
    ]);
    const plain = editRights(none, 'list');
    expect(visibleEditSections(plain, LIST_EDIT_SECTIONS)).toEqual(['profile']);
    expect(LIST_EDIT_SECTIONS).not.toContain('payments');
  });

  it('gives a global admin every section', () => {
    expect(visibleEditSections(editRights({ ...none, isGlobalAdmin: true }))).toEqual([
      ...EDIT_SECTIONS,
    ]);
  });
});

describe('parseEditSection', () => {
  it('accepts a section key and nothing else', () => {
    expect(parseEditSection('republications')).toBe('republications');
    expect(parseEditSection('admin')).toBeNull();
    expect(parseEditSection('')).toBeNull();
    expect(parseEditSection(null)).toBeNull();
    expect(parseEditSection(undefined)).toBeNull();
  });
});

describe('Back goes up exactly one level', () => {
  const labels = {
    directory: 'Associations',
    directoryHref: '/associations',
    asso: 'BDE',
    edit: 'Gestion',
    section: 'Partenariats',
  };

  it('section -> hub', () => {
    const trail = editTrail('bde', 'partnerships', labels);
    expect(trail.map((c) => c.label)).toEqual(['Associations', 'BDE', 'Gestion', 'Partenariats']);
    expect(previousCrumb(trail)?.href).toBe('/associations/bde/edit');
  });

  it('hub -> the public page of the entity', () => {
    expect(previousCrumb(editTrail('bde', null, labels))?.href).toBe('/associations/bde');
  });

  it('public page -> the directory', () => {
    const trail = editTrail('bde', null, labels);
    expect(trail[0]).toEqual({ label: 'Associations', href: '/associations' });
    expect(trail[1].href).toBe('/associations/bde');
  });

  it('every crumb of the path is a link and the last one is the current section', () => {
    const trail = editTrail('bde', 'members', labels);
    expect(trail.every((c) => c.href.startsWith('/'))).toBe(true);
    expect(trail.at(-1)?.href).toBe(editSectionHref('bde', 'members'));
  });

  it('a list keeps every level of its path under /lists', () => {
    const trail = editTrail('liste-x', 'members', {
      ...labels,
      directoryHref: '/lists',
      base: '/lists',
    });
    expect(trail.map((c) => c.href)).toEqual([
      '/lists',
      '/lists/liste-x',
      '/lists/liste-x/edit',
      '/lists/liste-x/edit/members',
    ]);
  });

  it('drops the entity crumb until its name is known', () => {
    const trail = editTrail('bde', null, { ...labels, asso: undefined });
    expect(trail.map((c) => c.label)).toEqual(['Associations', 'Gestion']);
  });
});
