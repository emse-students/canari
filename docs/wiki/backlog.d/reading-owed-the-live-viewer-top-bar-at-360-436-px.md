## Reading owed - the live viewer's top bar at 360-436 css px portrait (name whole, no button over the second row)

target: 1.7.0

Built: the top bar of `LiveViewer.svelte` no longer puts name and five actions in one shrinking row (Mi 9T, 436 css px, 2026-11-16: "Canari Te..." and the flag over the count row). The name column has a floor (`min-w-40`) and the actions are ONE non-shrinking group (`data-live-top-actions`, 44 px targets kept) that wraps whole to its own row under the name, LIVE badge, time and count when the name would fall under it; layout in [live](../frontend/modules/live.md#the-top-bar-at-narrow-widths-2026-11-16). Test: `LiveViewer.svelte.test.ts` (structure, since happy-dom has no layout).

Closing reading: a screenshot of the viewer on a 360-436 css px portrait phone (Mi 9T, and the iPhone's 390 pt) with the name whole at the longest length the app allows and no button over the second row, then the same at a doubled root font ([design-reference](../frontend/design-reference.md)). Charter: principle 7 (simple, light, pleasant). Found in [device-verification](../device-verification.md#the-mi-9t-readings-of-2026-11-16-second-sitting-on-170-alpha5-the-staged-rotation-and-editor-rows).

**iPhone 12, `1.7.0-alpha.6`, 2026-11-16/17 (seventh sitting, [verdicts](../device-verification.md)):** iPhone half PASS at 390 pt and at a doubled font for the name "Canari Test Delta"; the longest allowed name was not staged, so the entry stays open for that.
