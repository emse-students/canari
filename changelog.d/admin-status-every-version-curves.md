### Changed - the admin connections page draws a line for every platform and every version, over 24 h, 7 d or 30 d

The history no longer merges small cells (owner's decision of 2026-11-05): two line charts with a clickable legend and a hover tooltip replace the stacked area, a period selector adds 7 days and 30 days from a 5-minute peak series kept in Redis, and the live versions are broken down by platform. The reasoning, the Redis size arithmetic and what an admin can now read are in [chat-gateway](docs/wiki/services/chat-gateway.md#the-anonymous-census-and-its-24-hour-series-2026-11-02).
