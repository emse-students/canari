## Live titles and a preview on the feed card - decided by the owner on 2026-11-07, built, readings owed

**The four decisions (owner, 2026-11-07):**

1. **Title.** Optional, at most 80 characters, entered on the launch screen and editable on air.
   Without one, the card reads "X est en live".
2. **Preview.** A refreshed still, about one every 10 s, sealed under the live key. The card shows
   the EN DIRECT badge, the viewer count and the title. The preview takes NO viewer seat (the cap
   is 24) and adds no per-viewer poll beyond the feed's own load. (The review of #3135 changed the
   period to 16 s and the key to one DERIVED from the live key - below.)
3. **Layout.** One live: a LARGE card (preview, title, broadcaster, viewer count). Several: a
   horizontal carousel of those cards.
4. **Push.** The title goes in the "X est en live" notification ("BDE est en live : Soirée
   d'intégration").

**Built** on `feat/live-titles-and-preview` (migration 140): the mechanism, the key served without
a seat, where the preview is stored and what the card costs against the manifest poll are in
[lives](../services/lives.md#titles-and-the-preview-image-owner-2026-11-07); the card and the
broadcaster's capture in [live](../frontend/modules/live.md).

**Decided by the lead, all reversible:** JPEG only (WebKit has no WebP encoder); the card badge
reads "EN DIRECT" where the viewer keeps "LIVE"; the title is the push's BODY (the notification's
title stays "X est en live"); at most 256 KiB per preview; a preview shares the ingest concurrency
bound with segments; a muted account cannot edit a title; an account erasure clears the title.

**Decided at the review of #3135 (coordinator, 2026-11-07, all reversible):** the list serves a
POSTER key, `HKDF-SHA256(live key, salt = live id, info = "canari-live-poster-v1")`, only with a
poster - never the live key, which leaves only through the seated `GET /api/lives/:id`; ONE preview
period, 16 s, served as `previewPeriodMs`: the broadcaster sends one every 8 segments, a card on
screen re-reads the list once per period, the server refuses a second preview under 8 s; a poster
is fetched once per name; the poster has its own nginx path and zones, 8 Mb/s per address; the list
is `no-store`; a key that does not open logs once per outage; the title is edited by the
broadcaster ONLY, an association's live included.

**Owed, on the Mi 9T and the iPhone 12, on dev:**

- the canvas grab works on both engines (camera and, on a desktop, a shared screen), and the JPEG
  size of a 480 px frame (the bound is 256 KiB);
- the card's refresh while on screen and its stop off screen and in the background (the
  `[LIVE] feed card: reading the list (on screen)` lines);
- the carousel with two lives on air at once;
- the push text with and without a title, on Android and on iOS;
- the WebCrypto HKDF derivation on both engines (the card opens what the broadcaster sealed), and
  one `GET /api/media/public/live-poster/...` per new name in the network panel, none repeated.
