### Fixed - a live's sound no longer drifts ahead of its picture when the camera runs under 15 fps

The viewer gives each fragment's last video frame the interval the camera ran at, so MSE no longer drops audio at every fragment boundary; replays already stored are fixed too ([live](docs/wiki/frontend/modules/live.md#audio-drifts-ahead-of-the-video-under-15-fps-2026-11-19)).
