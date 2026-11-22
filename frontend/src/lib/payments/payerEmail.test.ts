import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizePayerEmail } from './payerEmail';

const here = dirname(fileURLToPath(import.meta.url));

describe('normalizePayerEmail', () => {
  it('trims and accepts an ordinary address', () => {
    expect(normalizePayerEmail('  a.b@example.com ')).toBe('a.b@example.com');
  });

  // Each is refused by core-service's PAYER_EMAIL_RE too: sending one costs the payer a refusal.
  it.each([
    '',
    'a',
    'a@b',
    'a b@c.fr',
    '@c.fr',
    'a@@c.fr',
    'a@b..fr',
    'a@b.fr.',
    'a@.b.fr',
    `${'a'.repeat(250)}@b.fr`,
  ])('refuses %j', (raw) => {
    expect(normalizePayerEmail(raw)).toBeNull();
  });

  // ONE shape on both sides: what the client accepts is exactly what core will send to Lydia.
  it("uses core-service's own payer e-mail pattern and length cap", () => {
    const core = readFileSync(
      resolve(here, '../../../../apps/core-service/src/payment/payment.controller.ts'),
      'utf8'
    );
    const mine = readFileSync(resolve(here, 'payerEmail.ts'), 'utf8');
    for (const name of ['PAYER_EMAIL_RE', 'PAYER_EMAIL_MAX_LENGTH']) {
      const line = new RegExp(`const ${name} = (.+);`);
      const theirs = core.match(line)?.[1];
      expect(theirs).toBeDefined();
      expect(mine.match(line)?.[1]).toBe(theirs);
    }
  });
});
