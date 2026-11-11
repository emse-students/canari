### Fixed - a video on a link slower than itself stops once, with its progress, instead of every few seconds

A starved stream now keeps its segments until the rest can play through, then plays to the end; the
player says how much is in. In the model of the owner's link, 29 stalls become 1
([video-player](docs/wiki/frontend/modules/video-player.md#a-link-slower-than-the-video-one-honest-load-2026-11-11)).
