/**
 * WHO MAY PIN A MESSAGE, decided in ONE place for every surface that offers it - the desktop
 * toolbar, the mobile long-press sheet, the pinned-messages banner's unpin, and the handler that
 * sends the request.
 *
 * The rule is the server's, restated here only because the client must not OFFER what the server
 * refuses (`ChannelService.setMessagePinned` in social-service, see
 * [social-service](../../../../../docs/wiki/services/social-service.md#message-moderation-channelmoderate)):
 *
 *  - in a community salon, pinning or unpinning SOMEONE ELSE's message is moderation - it needs
 *    `channel.moderate` (or a permission subsuming it), which the client is handed as the DECISION
 *    `viewerCanModerate` and never derives from a role name. The author may always pin their own.
 *  - in a DM or a group there are no ranks: a pin is an MLS frame between equals, so anybody may.
 *
 * Until 2026-10-05 the menus gated delete on this rule and pin on nothing, so a plain member was
 * offered "Pin" on every message of a salon; the server refused it with a 403 and the bubble
 * showed a pin that was never placed until the optimistic apply was reverted.
 */
export interface PinStanding {
  /** The conversation is a community salon, where pinning another member's message is moderation. */
  inChannel: boolean;
  /** The server's `viewerCanModerate` for that salon's community. Ignored outside a salon. */
  canModerate: boolean;
}

/**
 * Whether the viewer may pin - or unpin - `message` in a conversation where they stand as
 * `standing` describes.
 *
 * @param standing Where the viewer stands in this conversation.
 * @param message The message, reduced to the one fact the rule reads: whether the viewer wrote it.
 *   A message this device does not hold (an id from the server's pin list, not yet loaded) is not
 *   known to be the viewer's, so it is passed as `isOwn: false` and needs the moderation grant.
 */
export function mayPinMessage(standing: PinStanding, message: { isOwn: boolean }): boolean {
  if (!standing.inChannel) return true;
  return message.isOwn || standing.canModerate;
}
