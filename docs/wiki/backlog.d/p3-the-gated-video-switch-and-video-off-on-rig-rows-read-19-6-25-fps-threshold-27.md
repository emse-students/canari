## P3 - the gated `video-switch` and `video-off-on` call rows read 19.6-25 fps against a threshold of 27

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

Found in the noise-suppression run of call-noise-suppression ([calls](../frontend/modules/calls.md#noise-suppression-rnnoise---decided-2026-10-31-built-its-clean-speech-row-fails)): on Chrome 156, in two runs, the gated rows `video-switch` and `video-off-on` read 19.6-25 fps. The rig had not run since #2176 (it was broken until the change that ran it), so WHEN they started failing is unknown. First step: run both rows on the rig, then the same rows on the commit of #2176 to separate a regression of the app from a rig or Chrome-version shift; the threshold moves only with the measurement written here.
