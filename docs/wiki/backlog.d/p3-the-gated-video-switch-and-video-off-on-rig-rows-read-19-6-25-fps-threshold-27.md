## P3 - the gated `video-switch` and `video-off-on` call rows read 19.6-25 fps against a threshold of 27

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

Found in the noise-suppression run of call-noise-suppression ([calls](../frontend/modules/calls.md#noise-suppression-rnnoise---decided-2026-10-31-built-its-clean-speech-row-fails)): on Chrome 156, in two runs, the gated rows `video-switch` and `video-off-on` read 19.6-25 fps. The rig had not run since #2176 (it was broken until the change that ran it), so WHEN they started failing is unknown. First step: run both rows on the rig, then the same rows on the commit of #2176 to separate a regression of the app from a rig or Chrome-version shift; the threshold moves only with the measurement written here.

**2026-11-22, `1.7.3-alpha.5` tree, Chrome 158:** three runs of both rows on the same host read `video-switch` 27.7 then 16.2 fps and `video-off-on` 16.2 then 12.1 fps with 3-7 freezes. The spread inside one build (and a first run that passed `video-switch`) points at the host's load rather than the app. The second step could not be taken: the commit of #2176 did not answer `rig.setup` within 60 s under today's Chrome. Next: a quiet host, three runs each, and the bisect on a Chrome that runs that commit.

**2026-11-22, web/rig sitting on `1.7.3-alpha.6`, 3 runs of both rows on a host at about 60 % CPU (two phone sittings running):** `video-switch` 29.6 / 26.3 (1 freeze, FAIL) / 27.7 fps; `video-off-on` 28.5 / 29.8 / 25.7 (2 freezes, FAIL) fps. Four PASS and two FAIL at 25.7-26.3 fps, the same row passing and failing from run to run: LOAD-SENSITIVE, not a steady regression (the alpha.5 run on a busier host read 16.2 and 12.1 fps). The comparison on the #2176 commit was not taken. The threshold stays; the rows need a quiet host to gate, which is what to write into the rig README.
