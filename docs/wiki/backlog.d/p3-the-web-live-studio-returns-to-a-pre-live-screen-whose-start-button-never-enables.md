## Reading owed - "En direct" past an open web live screen no longer leaves it on "Reading the live's rules..." (S13, 2026-11-20)

target: 1.7.3

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**Seen** on `1.7.1-alpha.5` (dev) by the rig's throwaway scripts in S13
([S13](../device-verification.md#the-readings-of-2026-11-20-s13-171-alpha5-replays-sound-under-15-fps-messages-and-the-iphone)):
after a web live ended, the broadcaster overlay showed the pre-live sheet with Start greyed on
"Reading the live's rules..." and no `GET /api/lives/rules` for two minutes.

**Reproduced on dev `1.7.2-alpha.2`, 2026-11-20** (W5, `--fake-media`, a CDP script reading the
page's own console and network). Ending a live alone does NOT reproduce it: the overlay settles on
"Live termine / Fermer" (phase `ended`), one `[LIVE-BROADCAST] screen for` line per opening. What
reproduces it is a SECOND "En direct" while that ended screen is still mounted: the feed's own
"Publier" (reachable past the full-screen layer by the keyboard, or by a script's `click()`), then
"En direct". `[POSTS] going live from the composer` is logged, no `[live-overlay] open` (no remount),
**two** more `[LIVE-BROADCAST] screen for` lines and two `[LIVE-MIX] audio context running`, no
`[LIVE] limits|rules|standing` and no `GET /api/lives/{limits,rules,standing}` in the next 30 s, and the
overlay reads phase `preview`, Start disabled, "Reading the live's rules". Two live ids in the rig's
`WRITTEN-IDS.txt`.

**Cause.** `routes/posts/+page.svelte` `onGoLive` assigned `liveTarget` a new object while the screen
was mounted; the screen's machine was the prop fallback `broadcast = new LiveBroadcast(..., associationId)`
in `LiveBroadcaster.svelte`, which Svelte 5 evaluates as a `derived` of the props it reads, and
`associationId` is the getter `liveTarget.associationId`. So the screen got fresh `preview` machines
whose `loadLimits` (called in `onMount`) never ran, and the ones they replaced were never disposed.

**Built** (PR #3905): the screen makes its machine once at mount (`untrack`), and `onGoLive` refuses
to re-target an open screen (a `[POSTS]` warning). Both tests fail on the old code
([live](../frontend/modules/live.md)).

**The reading that closes it**, on the first pre-release carrying #3905, on a web seat with
`--fake-media`: start a live, end it, then "Publier" > "En direct" with the ended screen still
open. Expected: one `[LIVE-BROADCAST] screen for` line for the whole sequence, the warning
`[POSTS] going live while a live screen is open`, the overlay still on "Live termine"; then "Fermer",
"Publier" > "En direct" opens a fresh screen that reads the rules (`GET /api/lives/rules`) and
offers Start.

**2026-11-20, [S18](../device-verification.md#the-readings-of-2026-11-20-s18-172-alpha3-notice-previews-launcher-shortcuts-the-capture-line-live-screens-and-the-backup-domains) (`1.7.2-alpha.3`, phones): a second live after an ended live opens a FRESH pre-live sheet, PASS.** The web seat's console half (one `[LIVE-BROADCAST] screen for` line, the `[POSTS] going live while a live screen is open` warning, the overlay kept on "Live termine") was not read: that is what is left.
