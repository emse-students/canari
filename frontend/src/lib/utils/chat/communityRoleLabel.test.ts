import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  canonicalRoleOf,
  defaultRoleLabel,
  isAcceptableRoleLabel,
  resolveRoleLabel,
} from './communityRoleLabel';

/**
 * THE SAME VECTORS AS `role-label.spec.ts` in social-service: the editor's refusal and the server's
 * are one rule (per grapheme, emoji keep their zero-width joiner and tag glue).
 */
describe('isAcceptableRoleLabel', () => {
  it('keeps the glue of emoji: families, professions, the rainbow flag, the England flag', () => {
    const accepted = [
      '\u{1F468}‍\u{1F469}‍\u{1F467}',
      '\u{1F469}‍⚕️',
      '\u{1F3F3}️‍\u{1F308}',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
      'Bureau \u{1F469}‍\u{1F3A4}',
      'Présidence',
    ];
    for (const label of accepted) expect(isAcceptableRoleLabel(label)).toBe(true);
  });

  it('refuses a joiner or a tag that is not glue inside an emoji, and every invisible', () => {
    for (const bad of [
      'a‍b',
      '‍b',
      'ab‍',
      'a​b',
      'a\u{E0067}',
      '\u{E0067}b',
      '\u{1F600}​b',
      'a‎b',
      'a؜b',
      'a b',
      'a b',
      'a﻿b',
      'a\nb',
    ]) {
      expect(isAcceptableRoleLabel(bad)).toBe(false);
    }
  });
});

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
