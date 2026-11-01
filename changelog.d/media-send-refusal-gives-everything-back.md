### Fixed - a refused attachment send gives the caption and the file back, in place, and says so where it was made

A DM/group attachment refused before it is queued now answers `false`, so the caption cleared at
the tap returns to its draft (a send that threw does too). The file returns to its place in the
staging. A voice note or chat-reel take, which is not re-staged, is reported rather than dropped
in silence. The banner shows only if the member is still in the conversation the send was made in.
A missing MLS service no longer loses the claimed files. Follow-up to #2821
([media-send-queued-at-the-tap](docs/wiki/backlog.d/media-send-queued-at-the-tap.md)).
