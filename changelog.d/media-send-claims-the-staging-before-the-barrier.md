### Fixed - one staged file tapped Send on several times went out several times

A media send in a DM or group now takes the staged files before it waits for the membership check
(18 s on a stalled link), so a second tap finds nothing to send; 13 taps had sent 13 copies of one
video. The follow-up, queuing the file at the tap, is
[media-send-queued-at-the-tap](docs/wiki/backlog.d/media-send-queued-at-the-tap.md).
