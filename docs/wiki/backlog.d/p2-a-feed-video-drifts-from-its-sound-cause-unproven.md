## P2 - a feed video's picture drifted from its sound: every upload is now a constant 30 fps, the cause of the one production post is still owed

The owner's report of 2026-11-06 (one production post, 13.6 s, picture late and the sound off at the
end) and the decision it took - measure, then normalise every video to the Canari camera's constant
30 fps - are in [video-preparation](../frontend/video-preparation.md#constant-frame-rate), with the
numbers. The normalisation is built; the seam makes no drift on desktop Chrome, before or after.
Owed, in this order: the production file's per-sample `trun` numbers (the list is on that page), which
say whether the FILE drifts or only its playback; the `tools/video-av-sync` rows on the Mi 9T and the
iPhone 12; and a committed AAC fixture so one row runs in CI.
