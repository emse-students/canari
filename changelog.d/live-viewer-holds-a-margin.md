### Fixed - a live viewer behind a broadcaster on a bad link replayed the last seconds at every late segment

The viewer re-anchored a short buffer, and the end of a stall, BEHIND its playhead. It now never seeks backward: it holds three segments of margin, plays slightly slower to rebuild it (faster when far behind), and shows the kit's spinner over the last frame only when the buffer is really dry ([live](docs/wiki/frontend/modules/live.md#the-margin-the-pace-and-the-last-resort-owner-2026-11-09)).
