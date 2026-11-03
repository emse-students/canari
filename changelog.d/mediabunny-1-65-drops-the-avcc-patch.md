### Changed - mediabunny 1.65.0: upstream's Firefox avcC fix replaces our patch

mediabunny 1.65.0 strips the doubled SPS/PPS byte of Firefox's encoder itself, so `patches/mediabunny@1.63.0.patch` is deleted and its behavioural test now runs under a Firefox user agent; one Chrome reading is owed ([video-preparation](docs/wiki/frontend/video-preparation.md)).
