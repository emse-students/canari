### Added - the media service accepts a streamed, resumable upload in parts, none over 8 MiB

Server half only, additive and called by no client yet: open, put part, status, complete, cancel, with the daily budget reserved once and every body streamed to disk instead of buffered ([media-service](docs/wiki/services/media-service.md#upload-sessions-streamed-resumable-every-body-under-8-mib-wp-s1-2026-10-10), design in [media-streaming-upload](docs/wiki/services/media-streaming-upload.md)).
