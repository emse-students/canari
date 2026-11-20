### Fixed - a replay's short last segment is downloaded once, not again on every timeupdate near the end

A segment counted as held only when its range ran 0.5 s past its start, so a live's short last fragment was missing for good and refetched about 46 times in the final 12 s; held now means the buffer holds its whole measured extent ([live-replays](docs/wiki/live-replays.md#a-segment-is-held-when-the-buffer-holds-its-whole-measured-extent-s13-2026-11-20)).
