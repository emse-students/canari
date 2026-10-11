/**
 * Whether the feed holds back its FIRST draw because a deep-link landing is taking the reader
 * somewhere else.
 *
 * A notification tapped on a killed app starts on the default route, so the feed booted UNDER the
 * landing: its first answer was drawn and its twenty cards mounted a frame at a time while the PIN
 * path, `mls-init` and the `/chat` route ran on the same main thread. The heartbeat named it on the
 * Mi 9T (2026-10-11): one ~690 ms block - the feed drawn from its first answer - inside the
 * device-key derivation, then ~1.2 s of mount frames across `mls-init` and the routing. That page is
 * about to be left, so nothing it would draw is ever seen.
 *
 * ONLY THE FIRST DRAW IS HELD. A feed already on screen is never blanked by a landing (a warm tap
 * while reading the feed routes away from the cards the reader is looking at), and a landing that is
 * abandoned - the conversation is not on this device - releases the hold, so the feed then draws as
 * it always did. No clock is involved: the hold lasts exactly as long as the landing is pending.
 *
 * docs/wiki/frontend/notification-to-conversation-latency.md
 */
export function feedHeldForLanding(opts: {
  /** A deep-link target is published and not yet displayed or abandoned (`notifNav.pending`). */
  landingPending: boolean;
  /** The feed has already drawn an answer in this page instance. */
  feedDrawn: boolean;
}): boolean {
  return opts.landingPending && !opts.feedDrawn;
}
