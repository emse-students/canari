### Fixed - Firefox refused every video with sound, and would have shipped H.264 Chrome cannot seek

An AAC-LC audio track is now copied into the MP4 instead of forced through an AAC encoder Firefox does not have, and a malformed `avcC` from Firefox's H.264 encoder is rebuilt from the bitstream (mediabunny patch) ([video-preparation](docs/wiki/frontend/video-preparation.md#an-aac-lc-track-is-copied-and-a-firefox-avcc-is-rebuilt-2026-10-14)).
