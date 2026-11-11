### Fixed - a video on a link slower than itself waits once instead of stopping every few seconds

A starved stream now keeps its segments back until the rest can play through, then plays to the
end. The user sees nothing new, only the player's ordinary wait. In the model of the owner's link,
29 stalls become 1
([video-player](docs/wiki/frontend/modules/video-player.md#a-link-slower-than-the-video-one-honest-load-2026-11-11)).
