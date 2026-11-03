### Changed - `/admin/status` counts who is connected instead of listing them

The list of connected people and devices is gone: the page now shows totals, a 24-hour anonymous chart of connected devices by platform, and the app versions live right now. The gateway counts from its shared presence keys (no replica counts twice) and keeps one sample a minute for 24 hours ([census](docs/wiki/services/chat-gateway.md#the-anonymous-census-and-its-24-hour-series-2026-11-02)).
