### Added - every video plays near one loudness

The author's device measures a video's loudness (EBU R128) while preparing it, and every player
brings it toward -14 LUFS through Web Audio, raising a quiet one by at most +6 dB without clipping;
older videos play as before ([video-player](docs/wiki/frontend/modules/video-player.md#loudness)).
