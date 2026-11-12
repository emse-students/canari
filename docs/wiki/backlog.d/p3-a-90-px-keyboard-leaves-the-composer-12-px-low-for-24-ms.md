## P3 - a 90 px keyboard leaves the composer 12 px low for 24 ms on 3 of 5 rises (Mi 9T, 2026-10-13, re-read 2026-11-11)

The other half of the 90 px reading of 2026-10-13 (the one-frame drop to 702 was the double report,
now recognised at any keyboard height, [chat](../frontend/modules/chat.md#every-keyboard-rise-moves-the-composer-for-a-moment-on-both-phones-measured-2026-10-02-fixed-2026-10-09-reading-owed)).
Below the keyboard-open threshold (160 px on Android, `keyboardViewport.svelte.ts`, unchanged on
`main`) no keyboard is ever "open", so `computeSnapshot` pins nothing in those frames; the 12 px (one
`0.75rem`) comes from somewhere it does not reach. Cause not read. **Owed:** a per-frame record of
`innerHeight`, `visualViewport.height` and the footer's padding on that rise, on the Mi 9T with a
90 px keyboard (a floating or one-row keyboard), before any change.
