## P2 - a video's sound ran ahead of its picture: fixed (holes restored, a constant 30 fps), owed the phones' own readings and a CI row

The owner's report of 2026-11-06 is explained and fixed: Chrome's audio decoder closed the holes of
the source's audio track, so an encoded output's sound ran early by the sum of the holes, 0.845 s by
the end of the production post ([video-preparation](../frontend/video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes)).
Owed: the `tools/video-av-sync` rows run through the Mi 9T's and the iPhone 12's own encoders and
decoders (the restore rests on one decoded chunk per packet, checked there by a `console.error`,
not yet observed), and a committed AAC source so a copied-audio row runs in CI.
