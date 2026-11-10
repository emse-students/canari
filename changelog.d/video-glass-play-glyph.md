### Changed - the play button is a glass triangle with no disc

The paused video's play button, the gesture feedback's play and pause, and the poster before a first frame are drawn as the shape itself in Liquid Glass (blur and dark tint clipped to a rounded triangle or two bars, a light rim, a soft shadow); `VideoPlayDisc` becomes `VideoPlayGlyph`, the hit target stays a 64 px square. WebKit's blur through a clipped shape is not verified ([video-player](docs/wiki/frontend/modules/video-player.md#the-glass-play-glyph---a-triangle-with-no-disc-owner-2026-11-09)).
