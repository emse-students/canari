### Fixed - a shared post's card is always a 1200x630 image, and a failed lookup is never cached

`og:image` is now one rendered JPEG per post with its size and type declared, a timed-out enrichment is served `no-store` instead of cached for a minute, and the access log says why a hit was slow or degraded ([seo](docs/wiki/frontend/seo.md#a-shared-post-and-the-ten-days-it-previewed-as-nothing)).
