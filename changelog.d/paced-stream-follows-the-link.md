### Fixed - videos starve less on a slow link

A paced video stream now looks as far ahead as the measured download rate against the media's bitrate requires, instead of a fixed 10 s, so the next segment lands before it is needed. See [video-player](docs/wiki/frontend/modules/video-player.md).
