### Fixed - the live preview's follow-ups after #3135

A poster key that failed to derive is derived again at the next preview, and two cards asking for
the same preview share one fetch; the preview's nginx bound is documented as per address, and the
stale comments now name the poster key and route
([lives](docs/wiki/services/lives.md#what-the-preview-costs)).
