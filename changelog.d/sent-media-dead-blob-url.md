### Fixed - a picture you just sent no longer stays a blurred placeholder until a reload

The sent message's re-render started a second download of the same media, whose URL the pool revoked and handed to the bubble anyway; a load already on the wire now stays joinable, and the loader returns the pool's URL ([media-service](docs/wiki/services/media-service.md#a-load-on-the-wire-stays-joinable-and-the-pools-url-is-the-one-handed-out-2026-10-05)).
