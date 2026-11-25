import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPECTED_WRITE_REFUSALS,
  WRITE_CHANGES_MAX,
  WRITE_REFUSALS,
  writeRefusalOf,
} from './miconnect-editor.client';
import {
  CURSUS_MAX,
  hasControlCharacter,
  NAME_MAX,
  POSTS,
  validateProfileEdit,
} from './miconnect-profile';

/**
 * The CONTRACT between core-service and MiConnect's write policy (80-profile-editor.yaml,
 * `miconnect-profile-write`): two languages, one set of numbers, characters and codes, held together
 * here so a change to one side fails until the other follows.
 */
const BLUEPRINT = readFileSync(
  join(__dirname, '../../../../infrastructure/authentik/blueprints/80-profile-editor.yaml'),
  'utf8'
);

/** The policy's `is_control`, as written: asserted verbatim in the blueprint below. */
const POLICY_IS_CONTROL =
  'is_control = lambda c: ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F or ord(c) in (0x2028, 0x2029)';
/** The same predicate, transcribed, to compare with core-service's own on the boundary characters. */
const policyIsControl = (code: number) =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

describe('the MiConnect write flow contract', () => {
  it('admits the longest name core-service sends: two names of NAME_MAX and a space', () => {
    expect(BLUEPRINT).toMatch(new RegExp(`^\\s+NAME_MAX = ${2 * NAME_MAX + 1}$`, 'm'));
  });

  it('caps a write at the same number of UTF-8 bytes, and the biggest valid edit fits', () => {
    expect(BLUEPRINT).toMatch(new RegExp(`^\\s+CHANGES_MAX = ${WRITE_CHANGES_MAX}$`, 'm'));
    expect(BLUEPRINT).toContain('len(raw.encode("utf-8")) > CHANGES_MAX');
    // The widest name in UTF-8 per UTF-16 unit is a 3-byte BMP character.
    const wide = String.fromCharCode(0x20ac).repeat(NAME_MAX);
    const checked = validateProfileEdit({
      campus: 'saint-etienne',
      cursus: Array.from({ length: CURSUS_MAX }, () => ({ formation: 'ISMIN', promo: 2100 })),
      posts: [...POSTS],
      firstName: wide,
      lastName: wide,
    });
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    const p = checked.profile;
    const changes = JSON.stringify({
      name: `${p.firstName} ${p.lastName}`,
      attributes: { profile: p },
    });
    expect(Buffer.byteLength(changes, 'utf8')).toBeLessThan(WRITE_CHANGES_MAX);
  });

  it('refuses a cursus longer than CURSUS_MAX as a field problem', () => {
    const checked = validateProfileEdit({
      campus: 'gardanne',
      cursus: Array.from({ length: CURSUS_MAX + 1 }, () => ({ formation: 'ICM', promo: 2020 })),
      posts: [],
      firstName: 'Camille',
      lastName: 'Durand',
    });
    expect(checked).toMatchObject({ ok: false, problems: [{ field: 'cursus' }] });
  });

  it('calls the same characters control characters on both sides', () => {
    expect(BLUEPRINT).toContain(POLICY_IS_CONTROL);
    const boundary = [
      0x00, 0x0a, 0x1f, 0x20, 0x7e, 0x7f, 0x85, 0x9f, 0xa0, 0x2027, 0x2028, 0x2029, 0x202a,
    ];
    for (const code of boundary) {
      expect([code, hasControlCharacter(String.fromCharCode(code))]).toEqual([
        code,
        policyIsControl(code),
      ]);
    }
    const refused = validateProfileEdit({
      campus: 'gardanne',
      cursus: [],
      posts: ['EMSE'],
      firstName: `Camille${String.fromCharCode(0x0a)}X`,
      lastName: 'Durand',
    });
    expect(refused).toMatchObject({ ok: false, problems: [{ field: 'firstName' }] });
  });

  it('refuses with exactly the stable codes core-service types', () => {
    const codes = new Set([...BLUEPRINT.matchAll(/refuse\("([a-z_]+)"/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual([...WRITE_REFUSALS].sort());
    // A message written without `refuse` must carry a known code too.
    for (const m of BLUEPRINT.matchAll(/refused:([a-z_]+):/g))
      expect(WRITE_REFUSALS).toContain(m[1]);
    for (const code of EXPECTED_WRITE_REFUSALS) expect(WRITE_REFUSALS).toContain(code);
  });

  it('reads a code from the prefix only, never from the prose', () => {
    expect(writeRefusalOf(['refused:superuser: the target is a superuser'])).toBe('superuser');
    expect(writeRefusalOf(['the target is a superuser'])).toBeNull();
    expect(writeRefusalOf(['refused:unknown_code: x'])).toBeNull();
  });
});
