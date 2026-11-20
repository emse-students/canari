## Reading owed - the live card follows the feed tab, and the covers load without a 429 (owner, 2026-11-19; S14, 2026-11-20)

target: 1.7.2

Built: the live card lists association lives only under "Organisations" and every live the reader may watch
under the other tabs ([live](../frontend/modules/live.md)); and the poster loader fetches at most three
covers at once, so a feed of thirty replays no longer trips nginx's per-address connection bound
([cause](../frontend/modules/live.md#the-width-of-the-poster-fetches-s14-2026-11-20)). Owed, on dev, by the lead:

1. A member's personal live is NOT in the card under "Organisations"; it is under "Pour toi" and "Campus".
   An association live is in all three.
2. On a feed holding about thirty replays, a reload (and the iPhone launched alone) logs no
   `Live poster <id>: 429` WARN and the covers all draw.
