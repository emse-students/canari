import { frontendBaseUrl } from '../common/frontend-url';

/**
 * ONE MEMBER OF A PUBLIC ROSTER, AS A VISITOR WITHOUT AN ACCOUNT MAY SEE THEM.
 *
 * The ceiling is the public showcase, portail-etu.emse.fr (owner, 2026-11-02): it draws a name, a
 * role, a promo, a board badge and a photo. The photo is reached through the roster row
 * ({@link publicMemberAvatarUrl}); `userId` and `createdAt` are still served while the showcase
 * moves its photos onto `avatarUrl`, and go once it has. See docs/wiki/anonymous-surface.md.
 */
export interface PublicMember {
  /** The roster row's own random id: one line of one public roster, the showcase's list key. */
  id: string;
  /** Still served while the showcase builds its photos from it; see the interface's note. */
  userId: string;
  role: string | null;
  /** Whether the member holds any permission on the association - the showcase's "board". */
  isAdmin: boolean;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
  /** Still served beside `userId`; see the interface's note. */
  createdAt: Date;
  /**
   * The member's photo: an ABSOLUTE URL on Canari's public origin, so a consumer on another origin
   * (the showcase) uses it as it is. Answers a bodyless 404 when the member has no photo.
   */
  avatarUrl: string;
}

/**
 * The photo of one public roster row, as an absolute URL on Canari's public origin
 * (`FRONTEND_URL`, `frontendBaseUrl`). Built in ONE place so the roster and the published carte
 * hand out the same address for the same face.
 */
export function publicMemberAvatarUrl(memberId: string): string {
  return `${frontendBaseUrl()}/api/public/members/${encodeURIComponent(memberId)}/avatar`;
}
