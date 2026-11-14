## Decided by the user on 2026-10-23 - bookings redesign, sharing, reels, calls, payments, MiConnect, release

target: 1.9.0

All taken in session on 2026-10-23. Bookings rows are D44-D54 in [bookings-chantier](../bookings-chantier.md#redesign-decided-2026-10-23).

**Re-read 2026-11-11.** The release paragraph is spent: that stable was `v1.5.0` (2026-10-27, the day `ADMISSION_PROOF_SINCE` names), lives and video calls are in production. **Still open from it:** the Debian trixie base for the two Rust runtimes (the non-root half of the containers lot is done, [backlog](p3-two-service-images-still-run-as-root.md)); and, under MiConnect below, impersonation disabled and the profile-editor token restricted to non-admin accounts, neither visible in `infrastructure/authentik/`. The Pixel 6a is the user's personal phone, looked at only when the user asks.

**Bookings redesign** (mockups first, built *"Tout de suite, en parallele de la stable"*): rows D44-D54 of [bookings-chantier](../bookings-chantier.md#redesign-decided-2026-10-23).

**Sharing (#2311).** A shared reel card opens the reels viewer; the post page header Share opens the same sheet; no warning to the sender; no dedicated MLS message type (link plus card); the external link preview stays as is; single-destination send first, multi-send later.

**Reels and comments (#2309, #2310, #2314, #2327).** A long press on the reaction opens a vertical drawer. Minimal player: thin progress line at the bottom, no timecode, never a play/pause button at load or autoplay; rail order reaction, comments, share, download, then sound. Post comments use the same drawer as CanaReels with a short animation, no quoted post header, over the interface on phones. The Instagram quick-emoji strip is NOT wanted.

**Calls.** Full-screen call screen with name and photo on every platform (#2306). The iPhone Recents history of calls is KEPT. The app is not distributed in China. The native ring switch is split per platform (Master's decision).

**Payments.** Production Lydia is live for the user's test with the production pair; production accepts ONLY `LYDIA_ENV=production`; `payment_provider` stays `lydia` after the test.

**MiConnect** (user: *"MiConnect est une partie extremement sensible, beton, securisee; s'il faut signer, on signe"*). The Alumni SAML source is disabled in production (#2318, applied 2026-10-23, two fields changed); every SAML source must be signed and is enabled only with a verification certificate. The default `akadmin` account was DEACTIVATED in production on 2026-10-23. Impersonation is to be disabled; the profile-editor token is to be restricted to non-admin accounts. The `localhost:1420`/`1421` redirects are kept for now (local development has no dev identity provider). The authentik bump to 2026.8.5 is merged (#2315).

**Repository settings.** Secret-scanning push protection is enabled; a `code_scanning` rule (CodeQL, high or higher) was added to ruleset `22152902` on 2026-10-23.

**#2273** shipped in `v1.5.0`; its rules are in [channel-encryption section 25](../protocols/channel-encryption.md#25-a-member-hands-the-past-only-to-an-admission-it-can-verify-decided-by-the-user-2026-10-22).
