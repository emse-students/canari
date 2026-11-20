## P2 - the "Rediffusion" switch's label and hint are near-black and grey on the dark pre-live sheet, barely readable

target: 1.7.2

**Read on both phones, `1.7.2-alpha.1`, 2026-11-20 (S16, [readings](../device-verification.md#the-readings-of-2026-11-20-s16-172-alpha1-the-birthday-ring-the-composer-gap-the-pin-gate-the-ios-backup-pass-the-rediffusion-switch-the-web-image-drop-miconnect)).**
The pre-live sheet draws over the camera, and every text on it is white ("Passer en direct" reads
`rgb(255, 255, 255)` on the Mi 9T). The organiser's switch (#3896) is the shared `Toggle`
(`LiveBroadcaster.svelte`, `data-live-replay-switch`), whose label is `text-text-main` (`rgb(5, 5, 5)` in the
light theme) and whose hint is `text-text-muted` (`rgb(101, 104, 108)`): on the dark preview both screenshots
show "Rediffusion" as a dark word and its hint as faint grey lines, the hardest text of the sheet to read.

It is the organiser's consent to keep the video (charter, principle 1, [principes](../../principes.md)), so the
one control on the sheet that decides what is kept must be as legible as the rest. **Fix:** the toggle on this
sheet takes the sheet's white text (a variant of `Toggle` for a dark surface, or the colours passed in), and a
component test asserts the label is not `text-text-main` inside `[data-live-replay-switch]`. **Reading:** the
pre-live sheet on one phone, the label and hint as white as "Titre (facultatif)".
