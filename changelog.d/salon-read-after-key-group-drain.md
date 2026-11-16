### Fixed - a salon opened on a cold start no longer warns "missing seed" for seeds its key group was still draining

Rows whose seed is held are drawn at once; a row whose seed is missing while the key group drains
waits, unwarned, for the drain proof (`salonKeysNow`), then reads with the seed it brought
([channel-encryption 4.5](docs/wiki/protocols/channel-encryption.md#45-a-missing-seed-is-requested-and-said-out-loud)).

A salon row deleted, or a poll voted, while a page of it is still decoding or waiting for its seed
is no longer put back or rewound by that page, nor by the whole-history search.
