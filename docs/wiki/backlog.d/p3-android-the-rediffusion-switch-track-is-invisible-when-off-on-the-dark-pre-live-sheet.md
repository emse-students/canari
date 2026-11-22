## P3 - UI: Android, with Rediffusion OFF the switch track is invisible on the dark pre-live sheet (S17, 2026-11-20)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Read on the Mi 9T, sitting S17 of 2026-11-20: the label and hint are readable since the `on-media` tone, but with the switch OFF its track has no visible contrast on the dark sheet over the camera, so the control looks absent. Give the `on-media` tone of the shared `Toggle` an off-state track and border that read on a dark image, from the tokens in `src/app.css` (no raw hex). Verify on the Mi 9T, OFF and ON. Context: [live-replays](../live-replays.md).
