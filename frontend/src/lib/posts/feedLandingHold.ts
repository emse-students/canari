/**
 * Whether the feed holds back its FIRST draw because a deep-link landing is on its way somewhere
 * else.
 *
 * A notification tapped on a killed app starts on the default route, so the feed booted UNDER the
 * landing: its first answer was drawn and its twenty cards mounted a frame at a time while the PIN
 * path, `mls-init` and the `/chat` route ran on the same main thread. The heartbeat named it on the
 * Mi 9T (2026-10-11): one ~690 ms block - the feed drawn from its first answer - inside the
 * device-key derivation, then ~1.2 s of mount frames across `mls-init` and the routing. That page is
 * about to be left, so nothing it would draw is ever seen.
 *
 * THE HOLD ENDS THE MOMENT THE LANDING STOPS BEING ON ITS WAY - it reaches its route
 * (`notifNav.enRoute` turns false), or it is abandoned (nothing pending). It is NOT tied to the
 * target staying pending: that lasts while the conversation is displayed and, on a wide screen, after
 * the reader has left `/chat`, so a feed waiting for it would show skeletons for ever. And only the
 * FIRST draw is held: a feed already on screen is never blanked by a landing. No clock is involved.
 *
 * docs/wiki/frontend/notification-to-conversation-latency.md
 */
export function feedHeldForLanding(opts: {
  /** A landing is pending and has not reached its target's route yet (`notifNav.enRoute`). */
  landingEnRoute: boolean;
  /** The feed has already drawn an answer in this page instance. */
  feedDrawn: boolean;
}): boolean {
  return opts.landingEnRoute && !opts.feedDrawn;
}
