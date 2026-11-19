## Decided by the user on 2026-10-23 - what is still open, and the rules not written elsewhere (trimmed 2026-11-19)

target: 1.9.0

**Still open from that day:** the Debian trixie base for the two Rust runtimes (`FROM debian:bookworm-slim`
today; the non-root half of the containers lot is done, [backlog](p3-two-service-images-still-run-as-root.md));
and, under MiConnect, impersonation to be disabled and the profile-editor token restricted to non-admin
accounts, neither visible in `infrastructure/authentik/`. The Pixel 6a is the user's personal phone,
looked at only when the user asks.

**Sharing (#2311).** A shared reel card opens the reels viewer; the post page header Share opens the same sheet; no warning to the sender; no dedicated MLS message type (link plus card); the external link preview stays as is.

**Reels and comments (#2309, #2310, #2314, #2327).** The Instagram quick-emoji strip is NOT wanted (the drawer and the minimal player are on [reels](../frontend/modules/reels.md)).

**Calls.** The iPhone Recents history of calls is KEPT. The app is not distributed in China ([calls](../frontend/modules/calls.md)). The native ring switch is split per platform.

**MiConnect** (user: *"MiConnect est une partie extremement sensible, beton, securisee; s'il faut signer, on signe"*). Every SAML source must be signed and is enabled only with a verification certificate (the Alumni source is disabled in production, #2318). The `localhost:1420`/`1421` redirects are kept for now (local development has no dev identity provider).

Bookings rows D44-D54 are on [bookings-chantier](../bookings-chantier.md#redesign-decided-2026-10-23).
