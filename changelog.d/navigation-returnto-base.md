### Fixed - a `returnTo` carries no base path, and a bad `?redirect=` falls back instead of throwing

Follow-up to #1473: login `returnTo` is base-less so `resolve()` adds the base once, and `safeInternalPath` validates query-supplied redirects at the source.
