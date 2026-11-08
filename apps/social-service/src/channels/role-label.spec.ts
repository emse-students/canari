import { BadRequestException } from '@nestjs/common';
import { MAX_ROLE_LABEL_LENGTH, validateRoleLabel } from './channel.service';

/**
 * A role's display name is validated like the other community names - trimmed, bounded in the
 * characters a person sees, no control character - and an empty one is a RESET, not an error.
 * The database-backed behaviour is in `role-label.integration.spec.ts`.
 */
describe('validateRoleLabel', () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      if (e instanceof BadRequestException) return (e.getResponse() as { code?: string }).code;
    }
    return undefined;
  };

  it('trims and keeps a name exactly as typed', () => {
    expect(validateRoleLabel('  Présidence ')).toBe('Présidence');
    expect(validateRoleLabel('Bureau des élèves')).toBe('Bureau des élèves');
  });

  it('reads an absent, null or blank name as "none"', () => {
    expect(validateRoleLabel(undefined)).toBeNull();
    expect(validateRoleLabel(null)).toBeNull();
    expect(validateRoleLabel('   ')).toBeNull();
  });

  it('counts characters a person sees, not UTF-16 units', () => {
    expect(validateRoleLabel('a'.repeat(MAX_ROLE_LABEL_LENGTH))).toHaveLength(
      MAX_ROLE_LABEL_LENGTH
    );
    expect(validateRoleLabel('\u{1F3B5}'.repeat(MAX_ROLE_LABEL_LENGTH))).toHaveLength(
      MAX_ROLE_LABEL_LENGTH * 2
    );
    expect(codeOf(() => validateRoleLabel('a'.repeat(MAX_ROLE_LABEL_LENGTH + 1)))).toBe(
      'ROLE_LABEL_INVALID'
    );
  });

  it('refuses control and bidi-override characters and non-text, with a typed code', () => {
    for (const bad of ['a\nb', 'a\tb', 'a‮b', 'a⁧b', 7, {}]) {
      expect(codeOf(() => validateRoleLabel(bad))).toBe('ROLE_LABEL_INVALID');
    }
  });
});
