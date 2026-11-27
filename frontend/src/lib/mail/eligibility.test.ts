import { describe, expect, it } from 'vitest';
import contract from '../../../../libs/contracts/mail-domains.json';
import { MAIL_CLASS_BY_DOMAIN, mailClassOf } from './eligibility';

describe('MAIL_CLASS_BY_DOMAIN', () => {
  it('equals libs/contracts/mail-domains.json, which core-service and the relay are held to', () => {
    expect({ ...MAIL_CLASS_BY_DOMAIN }).toEqual(contract.classes);
  });
});

describe('mailClassOf', () => {
  it('classes the school domains exactly, case aside, and nothing else', () => {
    expect(mailClassOf('jane.doe@etu.emse.fr')).toBe('student');
    expect(mailClassOf('John.Roe@EMSE.FR')).toBe('staff');
    expect(mailClassOf('x@sub.emse.fr')).toBeNull();
    expect(mailClassOf('x@emse.fr.example.com')).toBeNull();
    expect(mailClassOf('x@example.com')).toBeNull();
    expect(mailClassOf('emse.fr')).toBeNull();
    expect(mailClassOf('@emse.fr')).toBeNull();
    expect(mailClassOf('')).toBeNull();
    expect(mailClassOf(null)).toBeNull();
  });
});
