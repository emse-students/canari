import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPECTED_WRITE_REFUSALS, WRITE_REFUSALS, writeRefusalOf } from './miconnect-editor.client';
import { NAME_MAX } from './miconnect-profile';

/**
 * The CONTRACT between core-service and MiConnect's write policy (80-profile-editor.yaml,
 * `miconnect-profile-write`): two languages, one set of numbers and codes, held together here so a
 * change to one side fails until the other follows.
 */
const BLUEPRINT = readFileSync(
  join(__dirname, '../../../../infrastructure/authentik/blueprints/80-profile-editor.yaml'),
  'utf8'
);

describe('the MiConnect write flow contract', () => {
  it('admits the longest name core-service sends: two names of NAME_MAX and a space', () => {
    expect(BLUEPRINT).toMatch(new RegExp(`^\\s+NAME_MAX = ${2 * NAME_MAX + 1}$`, 'm'));
  });

  it('refuses with exactly the stable codes core-service types', () => {
    const codes = new Set([...BLUEPRINT.matchAll(/refuse\("([a-z_]+)"/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual([...WRITE_REFUSALS].sort());
    for (const code of EXPECTED_WRITE_REFUSALS) expect(WRITE_REFUSALS).toContain(code);
  });

  it('reads a code from the prefix only, never from the prose', () => {
    expect(writeRefusalOf(['refused:superuser: the target is a superuser'])).toBe('superuser');
    expect(writeRefusalOf(['the target is a superuser'])).toBeNull();
    expect(writeRefusalOf(['refused:unknown_code: x'])).toBeNull();
  });
});
