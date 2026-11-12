## P3 - iPhone PIN gate: on a 390x844 screen the red banner clips the keypad's `0` key (read 2026-10-22)

The banner (a PIN from before a reset on another device) pushes the keypad down until its `0` key sits
behind the fixed `Deverrouiller` button; the dialog scrolls and nothing is lost, but a person sees no
zero until they scroll. Layout only: the dialog body reserves the height of the fixed button, or the
banner does not displace the keypad. The unlock itself answers (about 0.5 s on the dev web client).
**Re-read 2026-11-11: still real by code.** `PinModal.svelte` keeps the unlock button in the
modal's footer, outside the scroll region, so the `0` is no longer drawn BEHIND it, but the banner
still pushes the keypad below the fold of a 390x844 scroll region; no reading since. **Rig rule from
that reading:** over WDA, tap by the DRAWN position (screenshot pixels / 3 = points) and re-read the
screenshot after anything that opens a keyboard or a banner - the element rectangle goes stale, and
the "hang" first recorded that day was the rig tapping empty space. `ios.mjs tap` refuses a target
under the keyboard since #3007; the banner half is still the operator's.
