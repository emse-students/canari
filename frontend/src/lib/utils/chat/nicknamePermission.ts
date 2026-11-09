/**
 * WHO MAY NAME A MEMBER IN A CONVERSATION ("Modifier les pseudos"), decided in ONE place for the
 * screen that offers the pencil and the action that sends the change - the model is
 * `pinPermission.ts`.
 *
 * The rule is the owner's (2026-10-14, 2026-10-18), restated here only so the client does not OFFER
 * what the server refuses (`mayWriteCommunityNickname` in social-service):
 *
 *  - in a DM or a group there are no ranks: any member names any member, themselves included.
 *  - in a community, naming is moderation: it needs the grant the client is handed as the DECISION
 *    `viewerCanModerate`, never derived from a role name - except that the person named may always
 *    CLEAR their own nickname.
 *
 * A block between the two is not part of this rule: it is a fact about two people the server answers
 * (`block-status`), asked when the change is made.
 */
export interface NicknameStanding {
  /** The conversation is a community (a salon's register is its community's). */
  inCommunity: boolean;
  /** The server's `viewerCanModerate` for that community. Ignored outside one. */
  canModerate: boolean;
}

/** Whether the viewer may set (or, with `isReset`, clear) a member's nickname where they stand. */
export function mayNameMember(
  standing: NicknameStanding,
  change: { isSelf: boolean; isReset: boolean }
): boolean {
  if (!standing.inCommunity || standing.canModerate) return true;
  return change.isSelf && change.isReset;
}
