## Reading owed - the broadcaster's on-air top row at 390 pt and 360 css px (End and the chat toggle on screen)

target: 1.7.0

Built: on air, the top row of `LiveBroadcaster.svelte` no longer drew the chat toggle and End past the right edge (iPhone 12, 390 pt, `1.7.0-alpha.5`, 2026-11-16: absent from the accessibility tree, the broadcaster could only leave by Back or the edge swipe). It now uses the same layout as the viewer's top bar, from one shared module (`components/live/liveTopBar.ts`): the identity column has a floor, the actions (flip, mic, camera, share, chat toggle, End) are ONE non-shrinking group that wraps whole to its own row; layout in [live](../frontend/modules/live.md#the-top-bar-at-narrow-widths-2026-11-16). Test: `LiveBroadcaster.svelte.test.ts` (structure, since happy-dom has no layout).

Closing reading: a screenshot ON AIR at 390 pt (iPhone 12) and at 360 css px (a small Android), with the "Reconnexion..." pill showing and a title set, End and the chat toggle visible and tappable (44 px), then the same at a doubled root font ([design-reference](../frontend/design-reference.md)). Charter: principle 2 (a live must be endable from its own screen) and 6. Found in [device-verification](../device-verification.md#the-iphone-12-readings-of-2026-11-16-fourth-sitting-b-170-alpha5).
