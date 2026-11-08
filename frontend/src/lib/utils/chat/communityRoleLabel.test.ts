import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { canonicalRoleOf, defaultRoleLabel, resolveRoleLabel } from './communityRoleLabel';

/**
 * ONE resolver turns a role and the community's own name for it into what a screen draws. The role's
 * IDENTITY is the stored name; the label never decides anything.
 */
describe('communityRoleLabel', () => {
  it('reads the identity from the stored role name, French or English', () => {
    expect(canonicalRoleOf('Administrateur')).toBe('admin');
    expect(canonicalRoleOf('Modérateur')).toBe('moderator');
    expect(canonicalRoleOf('Moderator')).toBe('moderator');
    expect(canonicalRoleOf('Membre')).toBe('member');
  });

  it('falls back to the localized default for no label, null or a blank one', () => {
    expect(resolveRoleLabel('admin')).toBe(m.chat_role_admin());
    expect(resolveRoleLabel('moderator', null)).toBe(m.chat_role_moderator());
    expect(resolveRoleLabel('member', '   ')).toBe(m.chat_role_member());
    expect(defaultRoleLabel('admin')).toBe(m.chat_role_admin());
  });

  it("shows the community's own name when it set one, trimmed", () => {
    expect(resolveRoleLabel('admin', ' Présidence ')).toBe('Présidence');
    expect(resolveRoleLabel('member', 'Musicien')).toBe('Musicien');
  });
});
