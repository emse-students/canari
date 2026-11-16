/**
 * The respondent's account fields of a form (owner, 2026-11-16) - the client half: one set of ticks
 * in the editor saved as the two lists the server keeps, the declared fields a respondent with no
 * account is asked, and the responses list's identity columns and filter.
 */
import { describe, it, expect } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  declaredPayload,
  declaredProblem,
  editorChoicesOf,
  emptyDeclaredValues,
  emptyIdentityFilter,
  firstDeclaredProblem,
  identityCellText,
  identityColumnsOf,
  identityFilterValues,
  matchesIdentityFilter,
  offeredChoices,
  respondentSettingsPayload,
  transmittedFieldLabels,
  type RespondentIdentity,
} from './respondentFields';

describe('the editor saves one set of ticks as two lists', () => {
  it('joins from the account on a named form, and asks guests the same on a public one', () => {
    const choices = ['lastName', 'firstName', 'email', 'cursus'];
    expect(respondentSettingsPayload(choices, { isPublic: false, anonymous: false })).toEqual({
      respondentFields: ['lastName', 'firstName', 'cursus'],
      guestFields: [],
    });
    expect(respondentSettingsPayload(choices, { isPublic: true, anonymous: false })).toEqual({
      respondentFields: ['lastName', 'firstName', 'cursus'],
      guestFields: ['lastName', 'firstName', 'email', 'cursus'],
    });
  });

  it('joins nothing on an anonymous form and asks only what is declared, never a name', () => {
    expect(
      respondentSettingsPayload(['lastName', 'email', 'status', 'campus'], {
        isPublic: true,
        anonymous: true,
      })
    ).toEqual({ respondentFields: [], guestFields: ['status', 'campus'] });
    expect(offeredChoices(false, true)).toEqual(['cursus', 'status', 'campus']);
    expect(offeredChoices(false, false)).not.toContain('email');
  });

  it('reads a stored form back as the one set, a legacy form included', () => {
    expect(
      editorChoicesOf({ respondentFields: ['lastName', 'firstName'], guestFields: ['email'] })
    ).toEqual(['lastName', 'firstName', 'email']);
    expect(editorChoicesOf({})).toEqual([]);
  });
});

describe('a respondent the form cannot read from an account declares', () => {
  it('requires a formation and an entry year, or "none" alone', () => {
    const values = emptyDeclaredValues();
    expect(declaredProblem('cursus', values)).toBe(m.form_guest_identity_required());
    values.formation = 'ICM';
    expect(declaredProblem('cursus', values)).toBe(m.form_respondent_promo_invalid());
    values.promo = 2024;
    expect(declaredProblem('cursus', values)).toBeNull();
    expect(declaredPayload(['cursus'], values)).toEqual({
      declaredFormation: 'ICM',
      declaredPromo: 2024,
    });
    values.formation = 'none';
    expect(declaredPayload(['cursus'], values)).toEqual({ declaredFormation: 'none' });
  });

  it('sends only what the form asks, and names the first field left empty', () => {
    const values = { ...emptyDeclaredValues(), status: 'staff' };
    expect(firstDeclaredProblem(['status', 'campus'], values)).toBe('campus');
    expect(declaredPayload(['status'], values)).toEqual({ declaredStatus: 'staff' });
    expect(declaredPayload([], values)).toEqual({});
  });
});

describe('the responses list', () => {
  const member: RespondentIdentity = {
    source: 'account',
    cursus: [
      { promo: 2024, formation: 'ICM' },
      { promo: 2020, formation: 'Autre' },
    ],
    status: ['student', 'staff'],
    campus: 'gardanne',
  };
  const rows = [
    { respondentIdentity: member },
    { respondentIdentity: { source: 'declared', cursus: [{ promo: 2023, formation: 'ISMIN' }] } },
    { respondentIdentity: null },
  ] as { respondentIdentity: RespondentIdentity | null }[];

  it('draws a column for a field joined, asked, or carried by an answer', () => {
    expect(identityColumnsOf({ respondentFields: ['lastName'] }, [])).toEqual([]);
    expect(identityColumnsOf({ respondentFields: ['campus', 'cursus'] }, [])).toEqual([
      'cursus',
      'campus',
    ]);
    expect(identityColumnsOf({ anonymous: true, respondentFields: ['campus'] }, [])).toEqual([]);
    expect(identityColumnsOf({}, rows)).toEqual(['cursus', 'status', 'campus']);
  });

  it('writes each cell from the snapshot', () => {
    expect(identityCellText(member, 'cursus')).toBe(
      `2024 ICM, 2020 ${m.profile_formation_other()}`
    );
    expect(identityCellText(member, 'status')).toBe(
      `${m.form_respondent_status_student()}, ${m.form_respondent_status_staff()}`
    );
    expect(identityCellText(member, 'campus')).toBe(m.profile_campus_gardanne());
    expect(identityCellText(null, 'campus')).toBe('');
  });

  it('filters by promo, formation and status, promo and formation on ONE cursus', () => {
    expect(identityFilterValues(rows)).toEqual({
      promo: ['2024', '2023', '2020'],
      formation: ['Autre', 'ICM', 'ISMIN'],
      status: ['student', 'staff'],
    });
    const filter = { ...emptyIdentityFilter(), promo: '2020', formation: 'ICM' };
    expect(rows.filter((r) => matchesIdentityFilter(r, filter))).toHaveLength(0);
    const icm = { ...emptyIdentityFilter(), formation: 'ICM' };
    expect(rows.filter((r) => matchesIdentityFilter(r, icm))).toEqual([rows[0]]);
    const staff = { ...emptyIdentityFilter(), status: 'staff' };
    expect(rows.filter((r) => matchesIdentityFilter(r, staff))).toEqual([rows[0]]);
    expect(rows.filter((r) => matchesIdentityFilter(r, emptyIdentityFilter()))).toHaveLength(3);
  });

  it('lists in the respondent notice the fields the form joins', () => {
    expect(transmittedFieldLabels(['lastName', 'campus'])).toEqual([
      m.form_guest_identity_last_name(),
      m.form_respondent_field_campus(),
    ]);
  });
});
