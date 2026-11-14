## P3 - the gated `video-switch` and `video-off-on` call rows read 19.6-25 fps against a threshold of 27

target: 1.7.0

Found in the noise-suppression run of [call-noise-suppression](call-noise-suppression-clean-speech-gate-fails-and-readings-owed.md): on Chrome 156, in two runs, the gated rows `video-switch` and `video-off-on` read 19.6-25 fps. The rig had not run since #2176 (it was broken until the change that ran it), so WHEN they started failing is unknown. First step: run both rows on the rig, then the same rows on the commit of #2176 to separate a regression of the app from a rig or Chrome-version shift; the threshold moves only with the measurement written here.
