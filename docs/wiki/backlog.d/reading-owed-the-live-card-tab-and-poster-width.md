## Reading owed - the live card follows the feed tab, and the covers load without a 429 (owner, 2026-11-19; S14, 2026-11-20)

target: 1.7.3

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Built: the live card lists association lives only under "Organisations" and every live the reader may watch
under the other tabs ([live](../frontend/modules/live.md)); and the poster loader fetches at most three
covers at once, so a feed of thirty replays no longer trips nginx's per-address connection bound
([cause](../frontend/modules/live.md#the-width-of-the-poster-fetches-s14-2026-11-20)). Owed, on dev, by the lead:

1. A member's personal live is NOT in the card under "Organisations"; it is under "Pour toi" and "Campus".
   An association live is in all three.
2. On a feed holding about thirty replays, a reload (and the iPhone launched alone) logs no
   `Live poster <id>: 429` WARN and the covers all draw.

**2026-11-20, [S18](../device-verification.md#the-readings-of-2026-11-20-s18-172-alpha3-notice-previews-launcher-shortcuts-the-capture-line-live-screens-and-the-backup-domains) (`1.7.2-alpha.3`): row 1 half read, PASS.** A member's personal live card shows under "Pour toi" and "Campus" and NOT under "Organisations". **Left:** an association's live under all three tabs, and row 2 (the covers without a 429 on a feed of about thirty replays).
