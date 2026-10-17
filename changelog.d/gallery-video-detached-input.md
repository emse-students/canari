### Fixed - on Android, a video picked from the gallery on the CanaReels camera is no longer dropped

The file input outlives the camera's release while the picker is open; the camera backdrop is repainted once its exposure settles, and the selected feed tab scrolls into view at large text sizes ([reels](docs/wiki/frontend/modules/reels.md#the-capture-screen-c4)).
