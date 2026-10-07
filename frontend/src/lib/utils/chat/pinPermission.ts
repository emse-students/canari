/**
 * WHO MAY PIN A MESSAGE, decided in ONE place for every surface that offers it - the desktop
 * toolbar, the mobile long-press sheet, the pinned-messages banner's unpin, and the handler that
 * sends the request.
 *
 * The rule is the server's, restated here only because the client must not OFFER what the server
 * refuses (`ChannelService.setMessagePinned` in social-service, see
 * [social-service](../../../../../docs/wiki/services/social-service.md#message-moderation-channelmoderate)):
 *
 *  - in a community salon, pinning or unpinning ANY message is moderation - the author's own
 *    included, because a pin shows on every member's screen (user, 2026-10-05). It needs
 *    `channel.moderate` (or a permission subsuming it), which the client is handed as the DECISION
 *    `viewerCanModerate` and never derives from a role name.
 *  - in a DM or a group there are no ranks: a pin is an MLS frame between equals, so anybody may.
 *
 * Until 2026-10-05 the menus gated pin on nothing, so a plain member was offered "Pin" on every
 * message of a salon; the server refused other members' messages with a 403 and the bubble showed
 * a pin that was never placed until the optimistic apply was reverted.
 */
export interface PinStanding {
  /** The conversation is a community salon, where pinning another member's message is moderation. */
  inChannel: boolean;
  /** The server's `viewerCanModerate` for that salon's community. Ignored outside a salon. */
  canModerate: boolean;
}

/**
 * Whether the viewer may pin - or unpin - a message in a conversation where they stand as
 * `standing` describes. Authorship does not enter the rule: in a salon only the grant does, and
 * outside one everybody may.
 */
export function mayPinMessage(standing: PinStanding): boolean {
  if (!standing.inChannel) return true;
  return standing.canModerate;
}
