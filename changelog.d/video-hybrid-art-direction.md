### Changed - one art direction for the video player's controls: flat at rest, fake glass while transient, no blur on Android

Resting controls (play triangle, corner speaker, actions chip) are a bare flat glyph everywhere; the transient pieces are one fake-glass recipe (translucent fill, hairline, highlight, shadow) and only iOS adds a blur on top, since the Mi 9T measured the blur at 98-99 % janky frames. A pause no longer draws the pop and the resting triangle on top of each other. See [video-player](docs/wiki/frontend/modules/video-player.md).
