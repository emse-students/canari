import { describe, expect, it } from 'vitest';
import contract from '../../../../libs/contracts/mail-domains.json';
import { MAIL_DOMAINS, isMailEligibleAddress, isMailEligibleDomain } from './eligibility';

describe('MAIL_DOMAINS', () => {
  it('equals libs/contracts/mail-domains.json, which the relay is held to as well', () => {
    expect([...MAIL_DOMAINS]).toEqual(contract.domains);
  });
});

describe('isMailEligibleDomain', () => {
  it('admits the listed domains exactly, case aside, and nothing else', () => {
    expect(isMailEligibleDomain('etu.emse.fr')).toBe(true);
    expect(isMailEligibleDomain('EMSE.FR')).toBe(true);
    expect(isMailEligibleDomain('sub.emse.fr')).toBe(false);
    expect(isMailEligibleDomain('emse.fr.example.com')).toBe(false);
    expect(isMailEligibleDomain('example.com')).toBe(false);
    expect(isMailEligibleDomain('')).toBe(false);
    expect(isMailEligibleDomain(null)).toBe(false);
  });
});

describe('isMailEligibleAddress', () => {
  it('reads the domain after the last @, exactly', () => {
    expect(isMailEligibleAddress('prenom.nom@etu.emse.fr')).toBe(true);
    expect(isMailEligibleAddress('Staff@EMSE.fr')).toBe(true);
    expect(isMailEligibleAddress('"a@emse.fr"@example.com')).toBe(false);
    expect(isMailEligibleAddress('x@sub.emse.fr')).toBe(false);
    expect(isMailEligibleAddress('@emse.fr')).toBe(false);
    expect(isMailEligibleAddress('emse.fr')).toBe(false);
    expect(isMailEligibleAddress(null)).toBe(false);
  });
});
