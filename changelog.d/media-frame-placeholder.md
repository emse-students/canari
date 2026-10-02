### Added - a picture shows its blurred colours before it arrives, and a GIF file declares its size

The sender attaches a ~21-byte ThumbHash to every image (`MediaMsg` field 13, wire-compatible both ways) and reads a GIF file's dimensions at send time - [media-frame](docs/wiki/frontend/media-frame.md).
