### Fixed - a link preview's oEmbed enrichment no longer fails silently

Each failure is typed where it happens (refused, unreachable, an unusable answer) and logged once per preview: a WARN for the first two, debug for a third party's unusable answer ([chat-delivery](docs/wiki/services/chat-delivery.md#one-fetch-per-page-per-six-hours-not-one-per-reader-per-render)).
