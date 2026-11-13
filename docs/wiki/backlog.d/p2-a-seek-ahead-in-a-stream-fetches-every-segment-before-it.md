## P2 - a seek ahead in a streamed video fetches every segment before its target

target: 1.10.0

**What happens.** A stream appends its segments in order (`segmentedMediaStream.ts`, the fetch loop
in `openConsumer`). A seek past what is fetched is a demand (`wanted`), and the loop runs on until
the target is buffered. So a seek to 90 % of a 60 MB video downloads 54 MB first. On a weak link that
is minutes before the picture moves, and the bytes in between are paid for whether or not the reader
ever watches them. Measured in a test only (`a seek ahead of the buffer drives the in-order fetch up
to the segment holding the target`); no phone reading.

**Why it is not a one-line fix.** Segments are byte ranges of 1 MiB, not fragments: one cannot be
appended alone, because its first bytes may be the middle of an `mdat`. A direct seek needs to know
which byte the fragment holding time T starts at.

**What now exists for it.** Since #3377 the stream parses the file's `mfra`
(`mp4Duration.readMp4TailDuration`). Every `tfra` entry is exactly that index: a fragment's start
time and its `moof`'s byte offset. A direct seek would:
- read the index once (the same tail read);
- on a seek past the buffer, abort the in-order loop and `SourceBuffer.abort()` the parser;
- append from the `moof` at the offset its `tfra` names (a slice of the segment holding it), then go
  on in order from there;
- fill the gap only if the reader seeks back into it.

The questions it must answer: the trim floor (`streamSeekFloor`) becomes a set of ranges, not one cut;
the whole-file copy (`wholeFile`) is built only by a stream that holds every segment; and the
`ManagedMediaSource` eviction on iOS.

Where it is described: [video-player](../frontend/modules/video-player.md#a-stream-learns-its-length-from-its-tail-2026-11-11).
