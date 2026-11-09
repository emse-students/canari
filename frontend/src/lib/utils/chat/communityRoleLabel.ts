/**
 * What a community's role is CALLED on screen - the ONE resolver, and the one place the three
 * canonical roles meet their localized defaults.
 *
 * A community keeps three fixed roles (admin, moderator, member) and may give each its own display
 * name. The name is a LABEL: it is drawn here and nowhere else, and no decision ever reads it. The
 * role's identity is its canonical value - read from the stored role NAME, which a rename never
 * touches (`canonicalRoleOf`) - and every permission comes from the server's own decision flags.
 */

import { m } from '$lib/paraglide/messages';

/** The three roles a community has. */
export type CanonicalRole = 'member' | 'moderator' | 'admin';

/** Longest role display name, in characters a person sees. The server bounds it in code points (`MAX_ROLE_LABEL_LENGTH` there, the same number), so the editor counts code points too, never UTF-16 units. */
export const MAX_ROLE_LABEL_LENGTH = 40;

/**
 * The canonical role a stored role NAME stands for. Reads the role's identity (the `name` column,
 * never edited by a rename), NOT its display label: handing it a label is the bug this module
 * exists to prevent. An unrecognised name folds to `member`, like the server's own fold.
 */
export function canonicalRoleOf(roleName: string): CanonicalRole {
  const normalized = roleName.trim().toLowerCase();
  if (normalized.includes('admin')) return 'admin';
  if (normalized.includes('mod')) return 'moderator';
  return 'member';
}

/** The localized default name of a canonical role. */
export function defaultRoleLabel(role: CanonicalRole): string {
  if (role === 'admin') return m.chat_role_admin();
  if (role === 'moderator') return m.chat_role_moderator();
  return m.chat_role_member();
}

/**
 * The name to draw for a role: the community's own when it set one, the localized default
 * otherwise (no label, or a blank one, is "none").
 */
export function resolveRoleLabel(role: CanonicalRole, customLabel?: string | null): string {
  const custom = customLabel?.trim();
  return custom ? custom : defaultRoleLabel(role);
}

/**
 * Whether a role name is acceptable to the server's rule, so the editor can refuse before sending.
 * THE SAME RULE AS `roleLabelHasForbiddenCharacter` in social-service (`channel.service.ts`), with
 * the same test vectors: no control, invisible-formatting, line or paragraph separator character
 * (`\p{Cc}\p{Cf}\p{Zl}\p{Zp}`), judged per grapheme so emoji keep their glue - the zero-width joiner
 * U+200D and the tag characters U+E0020-U+E007F are allowed INSIDE a grapheme holding a pictographic
 * (or starting with U+1F3F4) and refused everywhere else. Length is a separate bound.
 */
export function isAcceptableRoleLabel(label: string): boolean {
  const forbidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  const emojiGlue = /[‍\u{E0020}-\u{E007F}]/gu;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
    label
  )) {
    const isEmoji = /\p{Extended_Pictographic}/u.test(segment) || segment.startsWith('\u{1F3F4}');
    if (forbidden.test(isEmoji ? segment.replace(emojiGlue, '') : segment)) return false;
  }
  return true;
}
