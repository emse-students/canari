import { describe, it, expect } from 'vitest';
import {
  duplicatedIdentityField,
  foldQuestionLabel,
  identityDuplicates,
  transmittedFieldsOf,
} from './identityDuplicate';

describe('foldQuestionLabel', () => {
  it('folds case, accents, trailing punctuation and spaces', () => {
    expect(foldQuestionLabel('  Prénom : ')).toBe('prenom');
    expect(foldQuestionLabel('ADRESSE   MAIL ?')).toBe('adresse mail');
  });
});

describe('duplicatedIdentityField', () => {
  it.each([
    ['Nom', 'lastName'],
    ['nom de famille', 'lastName'],
    ['Prénom', 'firstName'],
    ['PRENOM *', 'firstName'],
    ['Adresse mail', 'email'],
    ['E-mail', 'email'],
    ['Promo', 'cursus'],
    ['Campus', 'campus'],
    ['Statut', 'status'],
  ])('%s is %s', (label, field) => {
    expect(duplicatedIdentityField(label)).toBe(field);
  });

  it('matches nothing fuzzier than the list', () => {
    expect(duplicatedIdentityField('Nom du groupe')).toBeNull();
    expect(duplicatedIdentityField('Nom de ton binôme')).toBeNull();
    expect(duplicatedIdentityField('')).toBeNull();
    expect(duplicatedIdentityField(undefined)).toBeNull();
  });
});

describe('transmittedFieldsOf', () => {
  it('a named form transmits the joined account fields', () => {
    expect(
      transmittedFieldsOf(['lastName', 'firstName'], { isPublic: false, anonymous: false })
    ).toEqual(['lastName', 'firstName']);
  });

  it('follows the ticks: nothing ticked, nothing transmitted', () => {
    expect(transmittedFieldsOf([], { isPublic: false, anonymous: false })).toEqual([]);
  });

  it('an anonymous form never transmits a name or an e-mail', () => {
    expect(
      transmittedFieldsOf(['lastName', 'firstName', 'email', 'campus'], {
        isPublic: false,
        anonymous: true,
      })
    ).toEqual(['campus']);
  });

  it('on a public form the e-mail only a guest gives is not transmitted for a member', () => {
    expect(
      transmittedFieldsOf(['lastName', 'email'], { isPublic: true, anonymous: false })
    ).toEqual(['lastName']);
  });

  it('an anonymous cursus read from the account is still transmitted', () => {
    expect(
      transmittedFieldsOf(['cursus', 'cursusFromAccount'], { isPublic: false, anonymous: true })
    ).toEqual(['cursus']);
  });
});

describe('identityDuplicates', () => {
  const items = [
    { id: 'a', type: 'short_text', label: 'Nom' },
    { id: 'b', type: 'short_text', label: 'Adresse mail' },
    { id: 'c', type: 'text_block', label: 'Nom' },
    { id: 'd', type: 'short_text', label: 'Allergies' },
  ];

  it('flags only transmitted fields, only on questions', () => {
    const found = identityDuplicates(items, ['lastName', 'firstName']);
    expect([...found.keys()]).toEqual(['a']);
    expect(found.get('a')).toBe('Nom');
  });

  it('flags nothing when nothing is transmitted', () => {
    expect(identityDuplicates(items, []).size).toBe(0);
  });
});
