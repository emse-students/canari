## P3 - the live viewer's top bar in portrait truncates the broadcaster's name and its flag button overlaps the viewer-count row on the Mi 9T

target: 1.7.0

Found on the Mi 9T (436 css px wide, `1.7.0-alpha.5`, dev), 2026-11-16, while reading the live viewer's rotation. In portrait the top bar of `LiveViewer.svelte` fits five round buttons (flag, sound, rotate, chat, share) plus close in one row beside the broadcaster: the name reads "Canari Te..." and the flag button's lower edge sits over the first pixels of the second row (the LIVE badge, the duration and the viewer count: the screenshot shows the flag at y 145-195 and the count pill from y 185). Nothing is unreachable and the count stays readable; the same bar in landscape has room and draws cleanly. It was NOT measured on the iPhone's 390 pt, where it is likely worse.

Closing reading: a screenshot of the viewer on a 390 pt and a 436 css px portrait screen with the name whole (a name of the longest length the app allows) and no button over the second row, then the same at a doubled root font ([design-reference](../frontend/design-reference.md)). Charter: principle 7 (simple, light, pleasant). Found in [device-verification](../device-verification.md#the-mi-9t-readings-of-2026-11-16-second-sitting-on-170-alpha5-the-staged-rotation-and-editor-rows).
