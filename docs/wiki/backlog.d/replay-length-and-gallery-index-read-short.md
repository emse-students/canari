## P3 - a replay's card length is short by about 6 s and a saved replay is indexed at about 2 s by the Gallery
target: 1.7.2

Found in sitting S11 (2026-11-19), split from the replay-stall entry.

- **The card's length is short by about 6 s.** `durationMs` is taken from the FIRST segment's arrival to the
  last, and the first three segments arrive in one burst after the recorder's start-up, so the media they hold
  is not counted: 64.6 s on the card against 70.7 s of media on the Mi, 77.2 s against 82.7 s for the
  flip-and-pause live. The progress line's total jumps during play. Derive it from the media (`atMs` of the last
  segment plus its length), not from arrival times.
- **A saved replay is indexed by MediaStore at about 2 s.** The Gallery plays the whole fragmented MP4 but the
  listed length and the seek bar are wrong. Write a moov duration, or remux the saved part, so the gallery's
  index agrees with the file.
