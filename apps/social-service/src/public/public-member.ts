/**
 * ONE MEMBER OF A PUBLIC ROSTER, AS A VISITOR WITHOUT AN ACCOUNT MAY SEE THEM.
 *
 * The ceiling is the public showcase, portail-etu.emse.fr (owner, 2026-11-02): it draws a name, a
 * role, a promo, a board badge and a photo, and so this carries those and nothing else. No account
 * id - the photo is reached through the roster row ({@link publicMemberAvatarUrl}) - and no join
 * date. See docs/wiki/anonymous-surface.md.
 */
export interface PublicMember {
  /** The roster row's own random id: one line of one public roster, the showcase's list key. */
  id: string;
  role: string | null;
  /** Whether the member holds any permission on the association - the showcase's "board". */
  isAdmin: boolean;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
  /** Path of the member's photo on this origin; answers 404 when they have none. */
  avatarUrl: string;
}

/**
 * The photo of one public roster row, as a same-origin path. Built in ONE place so the roster and
 * the published carte hand out the same address for the same face.
 */
export function publicMemberAvatarUrl(memberId: string): string {
  return `/api/public/members/${encodeURIComponent(memberId)}/avatar`;
}
