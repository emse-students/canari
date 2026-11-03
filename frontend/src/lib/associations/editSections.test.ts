/**
 * THE RIGHTS A SECTION IS GATED ON, and the path that makes Back go up exactly one level.
 *
 * The old edit page validated a requested section only against its static list, so a typed
 * `/edit/danger` (or `?section=`) opened a section its reader held no right for. A section is a
 * route segment now, which makes the segment user input: `mayOpenEditSection` is what refuses it.
 */
import { describe, it, expect } from 'vitest';
import { ASSOCIATION_ADMIN_PRESET, AssociationPermissionFlag } from '$lib/associations/api';
import {
  EDIT_SECTIONS,
  EDIT_SECTIONS_BY_KIND,
  LIST_EDIT_SECTIONS,
  mayEnterEditArea,
  adminPresetFor,
  entityBase,
  firstAdminPresetFor,
  kindHasSection,
  kindOffersFlag,
  permissionMaskFor,
  editRights,
  editSectionHref,
  editTrail,
  mayOpenEditSection,
  memberGrantable,
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

  it('opens the bookings section on MANAGE_BOOKINGS alone, never on MANAGE_FORMS (D30)', () => {
    const bookings = editRights(withFlags(AssociationPermissionFlag.MANAGE_BOOKINGS));
    expect(visibleEditSections(bookings)).toEqual(['profile', 'reservations']);
    const forms = editRights(withFlags(AssociationPermissionFlag.MANAGE_FORMS));
    expect(mayOpenEditSection('reservations', forms)).toBe(false);
    const list = editRights(withFlags(AssociationPermissionFlag.MANAGE_BOOKINGS), 'list');
    expect(visibleEditSections(list, LIST_EDIT_SECTIONS)).toEqual(['profile', 'reservations']);
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

  it("keeps an institution's roster to the global admin, and an association's to MANAGE_MEMBERS", () => {
    const manager = withFlags(AssociationPermissionFlag.MANAGE_MEMBERS);
    expect(mayOpenEditSection('members', editRights(manager, 'institution'))).toBe(false);
    expect(
      mayOpenEditSection('members', editRights({ ...none, isSuperAdmin: true }, 'institution'))
    ).toBe(false);
    expect(
      mayOpenEditSection('members', editRights({ ...none, isGlobalAdmin: true }, 'institution'))
    ).toBe(true);
    expect(mayOpenEditSection('members', editRights(manager))).toBe(true);
    // Archiving still reads MANAGE_MEMBERS on an institution: only the roster moved.
    expect(mayOpenEditSection('danger', editRights(manager, 'institution'))).toBe(true);
  });

  it('gives a BDE super-admin nothing on an institution: it has no governing BDE', () => {
    const star = editRights({ ...none, isSuperAdmin: true }, 'institution');
    expect(visibleEditSections(star)).toEqual(['profile']);
    expect(star.delete).toBe(false);
    expect(mayOpenEditSection('danger', star)).toBe(false);
    // Its own members keep their flags.
    const own = editRights(withFlags(AssociationPermissionFlag.MANAGE_DOCUMENTS), 'institution');
    expect(own.documents).toBe(true);
  });

  it('keeps an institution audience to the global admin', () => {
    const star = editRights({ ...none, isSuperAdmin: true }, 'institution');
    expect(mayOpenEditSection('audience', star)).toBe(false);
    expect(
      mayOpenEditSection('audience', editRights({ ...none, isGlobalAdmin: true }, 'institution'))
    ).toBe(true);
  });

  // Owner, 2026-11-02 (G3): a list keeps the shop, its cotisation, its purchases, and collects
  // through a delegation - its money sections are back, with no Lydia account of its own.
  it('gives a list its sections in hub order, its money ones included, and never an audience', () => {
    const admin = editRights({ ...none, isGlobalAdmin: true }, 'list');
    expect(visibleEditSections(admin, LIST_EDIT_SECTIONS)).toEqual([
      'profile',
      'members',
      'payments',
      'documents',
      'achats',
      'cotisations',
      'delegation',
      'formulaires',
      'reservations',
      'partnerships',
      'republications',
      'danger',
    ]);
    const plain = editRights(none, 'list');
    expect(visibleEditSections(plain, LIST_EDIT_SECTIONS)).toEqual(['profile']);
    expect(LIST_EDIT_SECTIONS).not.toContain('audience');
  });

  it("opens a list's money sections on its shop right, and never holds its bank account", () => {
    const shop = editRights(withFlags(AssociationPermissionFlag.MANAGE_PRODUCTS), 'list');
    expect(visibleEditSections(shop, LIST_EDIT_SECTIONS)).toEqual([
      'profile',
      'payments',
      'achats',
      'cotisations',
      'delegation',
    ]);
    // Nobody holds a list's payout account - its own member, a BDE star, the platform admin.
    const payout = withFlags(AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT);
    expect(editRights(payout, 'list').payoutAccount).toBe(false);
    expect(editRights({ ...none, isGlobalAdmin: true }, 'list').payoutAccount).toBe(false);
    expect(editRights({ ...none, isGlobalAdmin: true }, 'association').payoutAccount).toBe(true);
  });

  it('gives an institution its selling-free sections plus its audience, and nothing to sell', () => {
    expect(EDIT_SECTIONS_BY_KIND.institution).toEqual([
      'profile',
      'members',
      'documents',
      'formulaires',
      'reservations',
      'partnerships',
      'republications',
      'audience',
      'danger',
    ]);
    expect(editRights({ ...none, isGlobalAdmin: true }, 'institution').products).toBe(false);
    for (const s of ['payments', 'achats', 'cotisations', 'delegation'] as const) {
      expect(kindHasSection('institution', s)).toBe(false);
    }
    expect(EDIT_SECTIONS_BY_KIND.association).toEqual([...EDIT_SECTIONS]);
  });

  it('opens the proposal queue of a list on either of its flags', () => {
    const list = (f: AssociationPermissionFlag) => editRights(withFlags(f), 'list');
    expect(
      visibleEditSections(list(AssociationPermissionFlag.PROPOSE_EVENT), LIST_EDIT_SECTIONS)
    ).toContain('republications');
    expect(
      visibleEditSections(list(AssociationPermissionFlag.MANAGE_FORMS), LIST_EDIT_SECTIONS)
    ).toContain('formulaires');
  });

  // F2: a BDE governing a list (its super-admin) enters the area without being a member - it may
  // delete its lists (owner, 2026-11-02); a member with no right and a stranger may not.
  it('admits a global admin, the BDE governing the entity and its own officers, nobody else', () => {
    const base = { isGlobalAdmin: false, isSuperAdmin: false, isMemberAdmin: false };
    expect(mayEnterEditArea(base)).toBe(false);
    expect(mayEnterEditArea({ ...base, isSuperAdmin: true })).toBe(true);
    expect(mayEnterEditArea({ ...base, isGlobalAdmin: true })).toBe(true);
    expect(mayEnterEditArea({ ...base, isMemberAdmin: true })).toBe(true);
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

describe('the permissions a kind offers are derived from its sections', () => {
  const F = AssociationPermissionFlag;
  const offered = (kind: 'association' | 'list' | 'institution') =>
    Object.values(F)
      .filter((v): v is AssociationPermissionFlag => typeof v === 'number')
      .filter((f) => kindOffersFlag(kind, f));

  it('offers a list the shop and never the bank account (G2)', () => {
    expect(offered('list').sort()).toEqual(
      [
        F.POST_AS_ASSO,
        F.PROPOSE_EVENT,
        F.MANAGE_MEMBERS,
        F.MANAGE_DOCUMENTS,
        F.MANAGE_FORMS,
        F.MANAGE_PRODUCTS,
        F.MANAGE_PARTNERSHIPS,
        F.MANAGE_BOOKINGS,
      ].sort()
    );
  });

  it('offers an institution the same set minus the shop, and never a bank right', () => {
    expect(permissionMaskFor('institution')).toBe(permissionMaskFor('list') & ~F.MANAGE_PRODUCTS);
    expect(kindOffersFlag('institution', F.MANAGE_PRODUCTS)).toBe(false);
    expect(kindOffersFlag('institution', F.MANAGE_PAYOUT_ACCOUNT)).toBe(false);
  });

  it('keeps every right for an association', () => {
    expect(kindOffersFlag('association', F.MANAGE_PRODUCTS)).toBe(true);
    expect(kindOffersFlag('association', F.MANAGE_PAYOUT_ACCOUNT)).toBe(true);
    expect(kindOffersFlag('association', F.MANAGE_PARTNERSHIPS)).toBe(true);
  });

  it('presets a new list admin with the shop and never the bank account (3359)', () => {
    expect(adminPresetFor('list') & F.MANAGE_PAYOUT_ACCOUNT).toBe(0);
    expect(adminPresetFor('list') & F.MANAGE_PRODUCTS).toBe(F.MANAGE_PRODUCTS);
    expect(adminPresetFor('list')).toBe(3359);
    expect(adminPresetFor('institution') & (F.MANAGE_PRODUCTS | F.MANAGE_PAYOUT_ACCOUNT)).toBe(0);
    expect(adminPresetFor('list') & F.MANAGE_PARTNERSHIPS).toBe(F.MANAGE_PARTNERSHIPS);
    expect(adminPresetFor('association')).toBe(ASSOCIATION_ADMIN_PRESET);
  });

  it("an institution's first admin never manages its members; other kinds get the full preset", () => {
    expect(firstAdminPresetFor('institution') & F.MANAGE_MEMBERS).toBe(0);
    expect(firstAdminPresetFor('institution')).toBe(
      adminPresetFor('institution') & ~F.MANAGE_MEMBERS
    );
    expect(firstAdminPresetFor('association')).toBe(adminPresetFor('association'));
    expect(firstAdminPresetFor('list')).toBe(adminPresetFor('list'));
  });

  it("the roster editor never hands an institution's member MANAGE_MEMBERS, but can take it back", () => {
    const all = 0xfff;
    expect(memberGrantable('institution', all, 0) & F.MANAGE_MEMBERS).toBe(0);
    expect(memberGrantable('institution', all, F.MANAGE_MEMBERS) & F.MANAGE_MEMBERS).toBe(
      F.MANAGE_MEMBERS
    );
    expect(memberGrantable('association', all, 0)).toBe(all);
    expect(memberGrantable('list', F.POST_AS_ASSO, 0)).toBe(F.POST_AS_ASSO);
  });

  it('puts a list under /lists and every other kind under /associations', () => {
    expect(entityBase('list')).toBe('/lists');
    expect(entityBase('association')).toBe('/associations');
    expect(entityBase('institution')).toBe('/associations');
  });
});
