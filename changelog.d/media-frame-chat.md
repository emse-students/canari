### Fixed - a chat photo, video, GIF or voice note no longer moves the thread when it loads

Every medium opens in a `MediaFrame` at its final size; old messages without a size shift once per device, then never again, and the reader's row stays put (1464 px of row growth measured on the Mi 9T before, 0 after) - [media-frame](docs/wiki/frontend/media-frame.md).
