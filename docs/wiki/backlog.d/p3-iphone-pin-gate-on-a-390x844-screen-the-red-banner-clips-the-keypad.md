## P3 - iPhone PIN gate: on a 390x844 screen the red banner clips the keypad's `0` key (read 2026-10-22)

The banner (a PIN from before a reset on another device) pushes the keypad down until its `0` key sits
behind the fixed `Deverrouiller` button; the dialog scrolls and nothing is lost, but a person sees no
zero until they scroll. Layout only: the dialog body reserves the height of the fixed button, or the
banner does not displace the keypad. The unlock itself answers (about 0.5 s on the dev web client).
**Rig rule from that reading:** over WDA, tap by the DRAWN position (screenshot pixels / 3 = points)
and re-read the screenshot after anything that opens a keyboard or a banner - the element rectangle
goes stale, and the "hang" first recorded that day was the rig tapping empty space.
