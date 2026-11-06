### Fixed

- Saving a reel no longer fails with "media is undefined" on a row the viewer plays: the save read `media[0]` alone, the viewer also reads `images` (an older server's name). Both now share `fullScreenMediaOf` ([saveReel](frontend/src/lib/reels/saveReel.ts)).
