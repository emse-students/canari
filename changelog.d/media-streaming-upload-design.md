### Changed - design of a streamed, resumable media upload with every request under 8 MiB

Docs only: how attachments, reels and camera takes can upload and download in bounded memory, each part independently sealed in the existing `segmented-v1` format and never over 8 MiB, so the school host's 10 MiB request-body wall stops mattering ([media-streaming-upload](docs/wiki/services/media-streaming-upload.md)).
