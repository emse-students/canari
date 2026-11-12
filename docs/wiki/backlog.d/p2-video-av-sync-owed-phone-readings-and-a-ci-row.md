## P2 - a video's sound ran ahead of its picture: fixed (holes restored, a constant 30 fps), owed the phones' own readings and a CI row

The owner's report of 2026-11-06 is explained and fixed: Chrome's audio decoder closed the holes of
the source's audio track, so an encoded output's sound ran early by the sum of the holes, 0.845 s by
the end of the production post ([video-preparation](../frontend/video-preparation.md#constant-frame-rate-and-the-audio-holes-the-decoder-closes)).
**The Mi 9T and iPhone 12 readings GATE the stable that ships it**: the `tools/video-av-sync` rows
through the phones' own encoders and decoders - the restore rests on one decoded chunk per packet,
checked there by a `console.error` but never observed - and the pre-pass decode timed on a phone.
**Re-read 2026-11-12 (batch 23): #3058 first ships in the stable `v1.6.6`** (`git tag --contains`),
and device-verification records no `video-av-sync` row read on either phone, so that stable went
out without the readings this entry said gate it. They stay owed, now against production.
Also owed: a committed AAC source so a copied-audio row runs in CI - not a fixture alone: the rig
makes its sources in Chrome, and Chrome on Linux has no AAC encoder, so the CI job also needs the
rig to take a committed source instead of encoding one (`tools/video-av-sync/README.md`).
