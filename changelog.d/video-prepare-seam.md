### Added - one seam that re-encodes any video on the device before upload

`prepareVideoForUpload` turns an Android WebM, an iPhone MOV or a gallery file into one fragmented
MP4 (H.264 + AAC, 720p, ~2.5 Mb/s) with WebCodecs, typed faults, progress and cancel
([video-preparation](docs/wiki/frontend/video-preparation.md)).
