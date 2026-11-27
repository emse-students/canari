import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIL_CLASSES, MAIL_CLASS_BY_DOMAIN, readSchoolMail } from './mail-class';

describe('mail class', () => {
  it('equals libs/contracts/mail-domains.json, the table every side is held to', () => {
    const contract = JSON.parse(
      readFileSync(join(__dirname, '../../../../libs/contracts/mail-domains.json'), 'utf8')
    ) as { classes: Record<string, string> };
    expect(MAIL_CLASS_BY_DOMAIN).toEqual(contract.classes);
    expect([...MAIL_CLASSES].sort()).toEqual(['staff', 'student']);
  });

  it('reads a school address into its class, normalised', () => {
    expect(readSchoolMail(' Jane.Doe@ETU.emse.fr ')).toEqual({
      address: 'jane.doe@etu.emse.fr',
      mailClass: 'student',
    });
    expect(readSchoolMail('john.roe@emse.fr')).toEqual({
      address: 'john.roe@emse.fr',
      mailClass: 'staff',
    });
  });

  it('refuses an absent claim, another domain, a subdomain and anything not one address', () => {
    for (const claim of [
      undefined,
      null,
      42,
      '',
      'nobody@example.org',
      'x@mail.emse.fr',
      'x@emse.fr.example.org',
      '@emse.fr',
      'a b@emse.fr',
      'a@b@emse.fr',
      'a@@etu.emse.fr',
      'a' + String.fromCharCode(9) + 'b@emse.fr',
      'emse.fr',
    ]) {
      expect(readSchoolMail(claim)).toBeNull();
    }
  });
});
