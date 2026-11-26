### Fixed - a link preview title no longer shows `&rsquo;` and its kin

The preview decoder knew five entities; it now decodes the full HTML5 set and numeric references once, in title, description and site name ([chat-delivery](docs/wiki/services/chat-delivery.md)). Previews are cached server-side for a short TTL only, so stale escaped titles expire on their own.
