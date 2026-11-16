## P2 - the on-air top row pushes the chat toggle and End off a 390 pt screen

target: 1.7.0

**Read 2026-11-16, iPhone 12 (390 pt wide), `1.7.0-alpha.5`, dev ([readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-fourth-sitting-b-170-alpha5)):** with a live on air, the accessibility tree lists flip (x 189), mic (241), camera (293) and share (345 to 390, flush with the right edge); the chat toggle ("Masquer la discussion") and End ("Terminer") are **not in the visible tree**, i.e. drawn past the right edge and not reachable by touch. When the "Reconnexion..." pill widened the left block, the whole group moved about 27 pt further off screen. The broadcaster could only leave through Back or the edge swipe.

**Where:** `frontend/src/lib/components/live/LiveBroadcaster.svelte`, the top row (a flex row with `justify-between`, no shrink or `min-w-0` on the left block, six icon buttons on the right). **To do:** let the left block shrink (`min-w-0` and truncate), or wrap the controls, then read it again on the iPhone 12 with the reconnect pill showing. Charter: principle 6 (kindness) and 2: a live that cannot be ended from its own screen.
